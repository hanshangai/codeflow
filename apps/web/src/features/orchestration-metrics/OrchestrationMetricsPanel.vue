<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { Empty, message } from "ant-design-vue";
import { curveMonotoneX, line as d3Line, scaleLinear, scaleLog } from "d3";
import { useRoute, useRouter } from "vue-router";
import {
  resolveOrchestrationMetricArtifactId,
  resolveOrchestrationMetricArtifactTarget,
  resolveOrchestrationMetricOverview,
  resolveOrchestrationMetricEvidenceTarget,
  resolveOrchestrationMetricsRefreshNotice,
  resolveOrchestrationMetricsViewState,
  sampleOrchestrationMetricCorrelationPoints,
} from "./orchestrationMetricsViewState";
import {
  clearOrchestrationMetricQueryCache,
  createOrchestrationMetricCacheContextKey,
  createOrchestrationMetricCacheRequestKey,
  isOrchestrationMetricQueryResultCacheable,
  resolveOrchestrationMetricCachedQuery,
  synchronizeOrchestrationMetricCacheSession,
  writeOrchestrationMetricQueryCache,
} from "./orchestrationMetricsQueryCache";
import { DatabaseOutlined, DownloadOutlined, EyeOutlined, FileSearchOutlined, InfoCircleOutlined, SearchOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons-vue";
import {
  ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DIMENSIONS,
  ORCHESTRATION_METRIC_CORRELATION_METRICS,
  ORCHESTRATION_METRIC_DEFINITIONS,
} from "@codeflowai/shared";
import type {
  ApiResult,
  Artifact,
  ArtifactFileEntry,
  ConversationEventEnvelope,
  IntakeId,
  OrchestrationId,
  OrchestrationMetricAnalysisResponse,
  OrchestrationMetricAnalysisMetadata,
  OrchestrationMetricBottleneckComponentSignal,
  OrchestrationMetricBottleneckItem,
  OrchestrationMetricBottleneckResponse,
  OrchestrationMetricCodeAttributionCommitItem,
  OrchestrationMetricCodeAttributionDimension,
  OrchestrationMetricCodeAttributionExecutionRef,
  OrchestrationMetricCodeAttributionResponse,
  OrchestrationMetricCorrelationMetric,
  OrchestrationMetricCorrelationResponse,
  OrchestrationMetricCostsResponse,
  OrchestrationMetricCostDimension,
  OrchestrationMetricContractDetailItem,
  OrchestrationMetricContractEvaluationStatus,
  OrchestrationMetricContractType,
  OrchestrationMetricConformanceDetailItem,
  OrchestrationMetricConformanceResponse,
  OrchestrationMetricDefinition,
  OrchestrationMetricDeliveryFact,
  OrchestrationMetricDeliveryResponse,
  OrchestrationMetricDoraValue,
  OrchestrationMetricFilters,
  OrchestrationMetricFlowInstanceItem,
  OrchestrationMetricFlowResponse,
  OrchestrationMetricNodeDetailItem,
  OrchestrationMetricRouteTarget,
  OrchestrationMetricExportDataset,
  OrchestrationMetricExportJob,
  OrchestrationMetricExperimentsResponse,
  OrchestrationMetricEvaluationCohortItem,
  OrchestrationMetricEvaluationCriterion,
  OrchestrationMetricExperimentComparability,
  OrchestrationMetricEvaluationSetItem,
  OrchestrationMetricEvaluationSetKind,
  OrchestrationMetricEvaluationSetSummary,
  OrchestrationMetricFreshnessStatus,
  OrchestrationMetricRateEnvelope,
  OrchestrationMetricScopeKind,
  OrchestrationMetricScopeOption,
  OrchestrationMetricSourceHealthItem,
  OrchestrationMetricSourcesResponseBody,
  OrchestrationMetricStatus,
  OrchestrationMetricSummary,
  OrchRuntimeEvidenceGetResponseBody,
  RawEngineEventEnvelope,
  NodeResultField,
  TaskAcceptanceCriterion,
  TaskIntake,
  TaskIntakeMetricCohortPairEvidenceRef,
  TaskIntakeMetricCohortSnapshot,
  WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../composables/useApiContext";
import { trackProductEvent } from "../../analytics/analytics";
import {
  getOrchestrationMetricDelivery,
  getOrchestrationMetricAnalysis,
  getOrchestrationMetricBottlenecks,
  getOrchestrationMetricCodeAttribution,
  getOrchestrationMetricCorrelations,
  getOrchestrationMetricContractDetails,
  getOrchestrationMetricConformance,
  getOrchestrationMetricCosts,
  getOrchestrationMetricExperiments,
  getOrchestrationMetricEvaluationSets,
  createOrchestrationMetricEvaluationSet,
  getOrchestrationMetricEvaluationSetItems,
  scoreOrchestrationMetricEvaluationSetItem,
  getOrchestrationMetricFlow,
  getOrchestrationMetricNodeDetails,
  getOrchestrationMetricScopes,
  getOrchestrationMetricSummary,
  getOrchestrationMetricSources,
  refreshOrchestrationMetrics,
  retryOrchestrationMetricSource,
  createOrchestrationMetricExport,
  getOrchestrationMetricExport,
  cancelOrchestrationMetricExport,
} from "../../api/orchestration-metrics";
import { createOrchIntake, getOrchArtifact, getOrchInstance, getOrchRuntimeEvidence, listOrchArtifactFiles, listOrchIntakes, upsertOrchIntake } from "../../api/orchestration";
import { useConfigStore } from "../../store/config";
import { useOrchestrationStore } from "../../store/orchestration";
import { useRequirementAnalysisStore } from "../../store/requirementAnalysis";
import { useWorkspacesStore } from "../../store/workspaces";
import { isWorkspaceClientOfflineError, notifyWorkspaceClientOffline } from "../../utils/clientOfflineNotice";
import { createBrowserUuid } from "../../utils/browserUuid";
import ArtifactFilePreview from "../orchestration/components/artifact-file-preview.vue";
import { buildArtifactPresentation, type ArtifactPresentationFile } from "../orchestration/components/artifact-preview-utils";
import CodeAttributionView from "./CodeAttributionView.vue";
import ControlledExperimentsView from "./ControlledExperimentsView.vue";
import OrchestrationMetricLineChart, {
  type OrchestrationMetricLineChartPoint,
  type OrchestrationMetricLineChartSeries,
} from "./OrchestrationMetricLineChart.vue";

defineOptions({ name: "OrchestrationMetricsPanel" });

type RangePreset = "7d" | "30d" | "90d" | "all";
type ExperimentView = "comparison" | "workbench" | "controlled";
type OverviewMetricCard = {
  key: string;
  label: string;
  value: string;
  detail?: string;
  definition: OrchestrationMetricDefinition;
  definitionTitle?: string;
  description?: string;
};

const simpleEmptyImage = Empty.PRESENTED_IMAGE_SIMPLE;
const mobileViewOptions = [
  { label: "概览", value: "overview" },
  { label: "流程效率", value: "flow" },
  // { label: "流程符合性", value: "conformance" },
  { label: "Token 消耗", value: "costs" },
  { label: "代码贡献", value: "code_attribution" },
  { label: "规格质量", value: "specification" },
  { label: "评估实验", value: "experiments" },
  { label: "交付效能 DORA", value: "delivery" },
  { label: "趋势对比", value: "trend" },
  // { label: "多信号节点异常", value: "bottleneck" },
  { label: "质量关联", value: "correlation" },
];

const { ctx: baseApiContext } = useApiContext();
const metricRequestController = shallowRef(new AbortController());
const ctx = computed(() => ({ ...baseApiContext.value, signal: metricRequestController.value.signal }));
clearOrchestrationMetricQueryCache();
const route = useRoute();
const router = useRouter();
const config = useConfigStore();
const orch = useOrchestrationStore();
const requirementAnalysis = useRequirementAnalysisStore();
const workspaces = useWorkspacesStore();
synchronizeOrchestrationMetricCacheSession(
  config.serverWsOrigin,
  String(config.userSummary?.userId ?? ""),
  config.sessionToken ?? "",
);
const initializing = ref(true);
const scopesLoading = ref(false);
const summaryLoading = ref(false);
const analysisLoading = ref(false);
const flowLoading = ref(false);
const conformanceLoading = ref(false);
const costsLoading = ref(false);
const experimentsLoading = ref(false);
const deliveryLoading = ref(false);
const codeAttributionLoading = ref(false);
const conformanceError = ref("");
const experimentsError = ref("");
const deliveryError = ref("");
const costsError = ref("");
const codeAttributionError = ref("");
const conformanceCompatibilityUnavailable = ref(false);
const refreshing = ref(false);
const candidatesLoading = ref(false);
const errorMessage = ref("");
const errorCode = ref("");
const dismissedFreshnessMessage = ref("");
const showTrendTotal = ref(true);
const showTrendSuccess = ref(true);
const hoveredTrendIndex = ref<number | null>(null);
const trendCanvasElement = ref<HTMLElement | null>(null);
const scopes = ref<OrchestrationMetricScopeOption[]>([]);
const selectedScopeKind = ref<OrchestrationMetricScopeKind>("mine");
const selectedScopeId = ref<string | null>(null);
const candidateSearch = ref("");
const candidates = ref<Array<{ kind: "user" | "enterprise"; id: string; label: string; description: string }>>([]);
const summary = ref<OrchestrationMetricSummary | null>(null);
const activeTab = ref("overview");
const focusedCohortKey = ref<string | null>(null);
const analysis = ref<OrchestrationMetricAnalysisResponse | null>(null);
const bottlenecks = ref<OrchestrationMetricBottleneckResponse | null>(null);
const correlations = ref<OrchestrationMetricCorrelationResponse | null>(null);
const correlationXMetric = ref<OrchestrationMetricCorrelationMetric>("duration");
const correlationYMetric = ref<OrchestrationMetricCorrelationMetric>("rework");
const correlationLoading = ref(false);
const flow = ref<OrchestrationMetricFlowResponse | null>(null);
const conformance = ref<OrchestrationMetricConformanceResponse | null>(null);
const costs = ref<OrchestrationMetricCostsResponse | null>(null);
const experiments = ref<OrchestrationMetricExperimentsResponse | null>(null);
const experimentView = ref<ExperimentView>("comparison");
const experimentCriteria = ref<OrchestrationMetricEvaluationCriterion[]>([]);
const experimentComparability = ref<OrchestrationMetricExperimentComparability>("all");
const experimentsPage = ref(1);
const experimentsPageSize = ref(10);
const focusedCohortMissing = ref(false);
const delivery = ref<OrchestrationMetricDeliveryResponse | null>(null);
const codeAttribution = ref<OrchestrationMetricCodeAttributionResponse | null>(null);
const sourceHealthDrawerOpen = ref(false);
const sourceHealthLoading = ref(false);
const sourceHealthError = ref("");
const sourceHealth = ref<OrchestrationMetricSourcesResponseBody | null>(null);
const retryingSourceKey = ref<string | null>(null);
let scopesRequestVersion = 0;
let candidateRequestVersion = 0;
let sourceHealthRequestVersion = 0;
let sourceRetryRequestVersion = 0;
const evaluationSets = ref<OrchestrationMetricEvaluationSetSummary[]>([]);
const evaluationSetsLoaded = ref(false);
const evaluationSetsLoading = ref(false);
const evaluationSetsError = ref("");
const evaluationSetCreating = ref(false);
const selectedEvaluationSet = ref<OrchestrationMetricEvaluationSetSummary | null>(null);
const evaluationSetItems = ref<OrchestrationMetricEvaluationSetItem[]>([]);
const evaluationSetItemsLoading = ref(false);
const evaluationSetItemTotal = ref(0);
const evaluationSetItemPage = ref(1);
const evaluationSetItemPageSize = ref(20);
const evaluationSetDraft = reactive<{ kind: OrchestrationMetricEvaluationSetKind; name: string; criterion: OrchestrationMetricEvaluationCriterion; sampleSize: number }>({
  kind: "online_sample", name: "", criterion: "trace_evidence_integrity", sampleSize: 20,
});
const evaluationScoreOpen = ref(false);
const evaluationScoreSaving = ref(false);
const evaluationScoreItem = ref<OrchestrationMetricEvaluationSetItem | null>(null);
const evaluationScoreStatus = ref<"passed" | "failed" | "missing_evidence">("passed");
const evaluationScoreExplanation = ref("");
const improvementModalOpen = ref(false);
const improvementCreating = ref(false);
const improvementWorkspaceId = ref<string | null>(null);
const improvementCohort = ref<OrchestrationMetricEvaluationCohortItem | null>(null);
const improvementCandidateCohorts = ref<OrchestrationMetricEvaluationCohortItem[]>([]);
const improvementCandidateCohortKey = ref<string | null>(null);
const improvementCandidatesLoading = ref(false);
const improvementCandidatesError = ref("");
const improvementMode = ref<"create" | "link">("create");
const improvementHypothesis = ref("");
const improvementTargetVersion = ref("");
const improvementObservationDays = ref(30);
const improvementAcceptanceText = ref("");
const improvementIntakes = ref<TaskIntake[]>([]);
const improvementIntakesLoading = ref(false);
const improvementIntakesError = ref("");
const improvementIntakeId = ref<string | null>(null);
const costsPage = ref(1);
const costsPageSize = ref(20);
const deliveryPage = ref(1);
const deliveryPageSize = ref(20);
const codeAttributionPage = ref(1);
const codeAttributionPageSize = ref(20);
const conformancePage = ref(1);
const conformancePageSize = ref(20);
const flowPage = ref(1);
const flowPageSize = ref(20);
const openingEvidenceInstanceId = ref<string | null>(null);
const evidenceDrawerOpen = ref(false);
const evidenceLoading = ref(false);
const evidenceMonitorLoading = ref(false);
const evidenceError = ref("");
const evidenceData = ref<OrchRuntimeEvidenceGetResponseBody | null>(null);
const evidenceTarget = ref<{ workspaceId: string; intakeId: string; instanceId: string; nodeId: string | null } | null>(null);
let metricEvidenceRequestVersion = 0;
const evidenceDrawerTitle = computed(() => evidenceData.value?.traceDetail ? "调用证据详情" : "运行证据目录");
const nodeExecutionDrawerOpen = ref(false);
const nodeExecutionLoading = ref(false);
const nodeExecutionNodeId = ref("");
const nodeExecutionRoleStageId = ref("");
const nodeExecutionLabel = ref("");
const nodeExecutionRows = ref<OrchestrationMetricNodeDetailItem[]>([]);
const nodeExecutionWarning = ref("");
const nodeExecutionPage = ref(1);
const nodeExecutionPageSize = ref(50);
const nodeExecutionTotal = ref(0);
let nodeExecutionRequestVersion = 0;
const contractDetailDrawerOpen = ref(false);
const contractDetailLoading = ref(false);
const contractDetailError = ref("");
const contractDetailRows = ref<OrchestrationMetricContractDetailItem[]>([]);
const contractDetailPage = ref(1);
const contractDetailPageSize = ref(50);
const contractDetailTotal = ref(0);
const contractTypeFilter = ref<OrchestrationMetricContractType | "all">("all");
const contractStatusFilter = ref<OrchestrationMetricContractEvaluationStatus | "all">("all");
let contractDetailRequestVersion = 0;
const artifactDetailDrawerOpen = ref(false);
const artifactDetailLoading = ref(false);
const artifactDetailError = ref("");
const artifactFilesError = ref("");
const artifactDetail = ref<Artifact | null>(null);
const artifactDetailFiles = ref<ArtifactFileEntry[]>([]);
const artifactDetailFields = ref<NodeResultField[]>([]);
const artifactDetailRecord = ref<OrchestrationMetricContractDetailItem | null>(null);
const artifactDetailWorkspaceId = ref<WorkspaceId | null>(null);
const artifactPreviewPath = ref("");
const openingArtifactId = ref<string | null>(null);
let artifactDetailRequestVersion = 0;
let summaryCommitVersion = 0;
let dashboardRequestVersion = 0;
let refreshRequestVersion = 0;
let analysisRequestVersion = 0;
let correlationRequestVersion = 0;
let flowRequestVersion = 0;
let conformanceRequestVersion = 0;
let costsRequestVersion = 0;
let experimentsRequestVersion = 0;
let improvementCandidatesRequestVersion = 0;
let improvementIntakesRequestVersion = 0;
let evaluationSetsRequestVersion = 0;
let deliveryRequestVersion = 0;
let codeAttributionRequestVersion = 0;
let initializationRequestVersion = 0;
let componentActive = false;
let viewContextReady = false;
const exportJob = ref<OrchestrationMetricExportJob | null>(null);
const exportLoading = ref(false);
const exportPollError = ref("");
let exportPollTimer: ReturnType<typeof setTimeout> | null = null;
let exportRequestVersion = 0;

const filters = reactive({
  range: "30d" as RangePreset,
  workflowIds: [] as string[],
  roleStages: [] as string[],
  models: [] as string[],
  page: 1,
  pageSize: 20,
  compareMode: "previous_period" as const,
  dimension: "workflow" as NonNullable<OrchestrationMetricFilters["dimension"]>,
  costDimension: "workflow" as OrchestrationMetricCostDimension,
  codeAttributionDimension: "workflow" as OrchestrationMetricCodeAttributionDimension,
});
let activeQuerySnapshot: OrchestrationMetricFilters | null = null;
let activeQueryRange: RangePreset = filters.range;
let renderedMetricContextKey = "";

const rangeOptions: Array<{ label: string; value: RangePreset }> = [
  { label: "最近 7 天", value: "7d" },
  { label: "最近 30 天", value: "30d" },
  { label: "最近 90 天", value: "90d" },
  { label: "全部时间", value: "all" },
];
const analysisDimensionOptions = [
  { label: "按工作流", value: "workflow" },
  { label: "按节点", value: "node" },
  { label: "按角色阶段", value: "role_stage" },
  { label: "按状态", value: "status" },
  { label: "按质量事件", value: "quality_event" },
] satisfies Array<{ label: string; value: NonNullable<OrchestrationMetricFilters["dimension"]> }>;
const costDimensionOptions = [
  { label: "工作流", value: "workflow" },
  { label: "节点", value: "node" },
  { label: "角色", value: "role" },
  { label: "模型", value: "model" },
] satisfies Array<{ label: string; value: OrchestrationMetricCostDimension }>;
const experimentViewOptions = computed(() => [
  { label: "周期对比", value: "comparison" },
  { label: "评估工作台", value: "workbench" },
  { label: "受控实验", value: "controlled", disabled: selectedScopeKind.value !== "mine" },
]);
const improvementWorkspaceOptions = computed(() => workspaces.workspaces.map((workspace) => ({
  label: workspace.title || workspace.path || workspace.id,
  value: String(workspace.id),
  disabled: workspace.entryStatus != null && workspace.entryStatus !== "available",
})));
const improvementCandidateCohort = computed(() => improvementCandidateCohorts.value
  .find((cohort) => cohort.cohortKey === improvementCandidateCohortKey.value) ?? null);
const improvementCandidateOptions = computed(() => improvementCandidateCohorts.value.map((cohort) => ({
  value: cohort.cohortKey,
  label: `${cohort.nodeId} · Workflow ${shortSnapshotHash(cohort.workflowSnapshotHash)} · Role ${shortSnapshotHash(cohort.roleSnapshotHash)} · Prompt ${shortSnapshotHash(cohort.promptDefinitionHash)} · ${cohort.engine}/${cohort.model || "未记录"}/${cohort.effort || "未记录"}`,
})));
const contractTypeOptions = [
  { label: "全部类型", value: "all" },
  { label: "Gate", value: "gate" },
  { label: "验收标准", value: "acceptance" },
  { label: "Artifact", value: "artifact" },
  { label: "输出字段", value: "output_field" },
  { label: "运行证据", value: "runtime_evidence" },
] as const;
const contractStatusOptions = [
  { label: "全部状态", value: "all" },
  { label: "已通过", value: "passed" },
  { label: "未通过", value: "failed" },
  { label: "缺少证据", value: "missing_evidence" },
  { label: "未评价", value: "not_evaluated" },
] as const;
const specificationTrendCategories = [
  { key: "gate", label: "Gate 覆盖", color: "#2f6f6d" },
  { key: "artifact", label: "Artifact 覆盖（含输出字段）", color: "#4472a8" },
  { key: "acceptance", label: "验收标准覆盖", color: "#b26a2f" },
  { key: "runtime_evidence", label: "运行证据覆盖", color: "#7a5a9a" },
] as const;

/** Builds one responsive specification-coverage curve from server-owned bucket rates. */
function specificationTrendPath(category: typeof specificationTrendCategories[number]["key"]): string {
  const buckets = summary.value?.specificationTrend ?? [];
  const points = buckets.map((bucket, index) => ({
    x: buckets.length <= 1 ? 0 : (index / (buckets.length - 1)) * 1000,
    rate: bucket.categories.find((item) => item.category === category)?.coverageRate ?? null,
  }));
  return d3Line<{ x: number; rate: number | null }>()
    .defined((point) => point.rate !== null)
    .x((point) => point.x)
    .y((point) => 160 - point.rate! * 140)
    .curve(curveMonotoneX)(points) ?? "";
}

/** Returns the latest available coverage value for one specification category. */
function latestSpecificationCoverage(category: typeof specificationTrendCategories[number]["key"]): number | null {
  const buckets = summary.value?.specificationTrend ?? [];
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const rate = buckets[index]?.categories.find((item) => item.category === category)?.coverageRate ?? null;
    if (rate !== null) return rate;
  }
  return null;
}

const scopeOptions = computed(() => scopes.value.map((scope) => ({
  label: scope.label || scope.scopeKind,
  value: scope.scopeKind,
  disabled: scope.disabled,
})));
const selectedScope = computed(() => scopes.value.find((scope) => scope.scopeKind === selectedScopeKind.value) ?? null);
const requiresCandidate = computed(() => false);
const candidateKind = computed<"user" | "enterprise">(() => "enterprise");
const candidateOptions = computed(() => candidates.value.map((item) => ({
  value: item.id,
  label: item.description ? `${item.label} / ${item.description}` : item.label,
})));
const workflowOptions = computed(() => (summary.value?.workflowOptions ?? []).map((item) => ({
  label: `${item.workflowName || item.workflowId} (${item.count})`,
  value: item.workflowId,
})));
const roleStageOptions = computed(() => (summary.value?.roleStageOptions ?? []).map((item) => ({
  label: `${item.label} (${item.count})`,
  value: item.value,
})));
const modelOptions = computed(() => (summary.value?.modelOptions ?? []).map((item) => ({
  label: `${item.label} (${item.count})`,
  value: item.value,
})));
const loading = computed(() => initializing.value || scopesLoading.value || summaryLoading.value || flowLoading.value);
const canQuery = computed(() => !requiresCandidate.value || Boolean(selectedScopeId.value));
const cards = computed(() => summary.value?.cards ?? null);
const privacySuppressed = computed(() => summary.value?.privacy.status === "suppressed");
const detailsAllowed = computed(() => summary.value?.privacy.detailsAllowed !== false);
const privacyMessage = computed(() => privacySuppressed.value
  ? "当前统计范围暂不可展示结果指标、明细和行级导出。"
  : "");
const artifactPresentation = computed(() => buildArtifactPresentation(artifactDetail.value, artifactDetailFiles.value));
const artifactPreviewOptions = computed(() => {
  const presentation = artifactPresentation.value;
  const files = presentation.files.length ? presentation.files : [presentation];
  return files.map((file) => ({ label: file.filePath, value: file.filePath, file }));
});
const selectedArtifactPreview = computed<ArtifactPresentationFile | null>(() => {
  const options = artifactPreviewOptions.value;
  return options.find((option) => option.value === artifactPreviewPath.value)?.file ?? options[0]?.file ?? null;
});
/** Reports malformed Artifact content explicitly while preserving the raw preview for diagnosis. */
const artifactContentError = computed(() => {
  const artifact = artifactDetail.value;
  if (!artifact) return "";
  try {
    JSON.parse(String(artifact.contentJson ?? ""));
    return "";
  } catch (error) {
    return `Artifact contentJson 解析失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
const overview = computed(() => summary.value ? resolveOrchestrationMetricOverview(summary.value, flow.value) : null);
/** Builds the six actionable overview cards without recalculating server-owned metric rates. */
const overviewMetricCards = computed<OverviewMetricCard[]>(() => {
  const currentSummary = summary.value;
  const current = overview.value;
  if (!currentSummary || !current) return [];
  const specification = currentSummary.specification;
  const flowResult = flow.value;
  const flowDetail = flowLoading.value
    ? "流程效率加载中"
    : !flowResult
      ? "流程效率不可用"
      : flowResult.metadata.dataQuality.consistency === "conflicted"
        ? "状态区间存在冲突，需进入流程效率核查"
        : flowResult.metadata.partial
          ? `${flowResult.totals.sampleCount} 个实例 · 部分数据`
          : `${flowResult.totals.sampleCount} 个可计算实例`;
  return [
    {
      key: "verified-success",
      label: "验证通过率",
      value: formatObservedRate(current.observedSuccess),
      detail: formatValidationRateDetail(current.observedSuccess, "通过率"),
      definition: ORCHESTRATION_METRIC_DEFINITIONS.observedVerifiedSuccessRate,
      definitionTitle: "验证通过率怎么算",
      description: "在已有验证结论的可评价实例中，最终通过全部验证的比例。",
    },
    {
      key: "first-pass",
      label: "一次通过率",
      value: formatObservedRate(current.observedFirstPass),
      detail: specification
        ? formatValidationRateDetail(current.observedFirstPass, "一次通过率")
        : "当前服务尚未提供规格质量口径",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.observedFirstPassRate,
      definitionTitle: "一次通过率怎么算",
      description: "在已有验证结论的可评价实例中，未经过重试、返工或评审驳回，直接通过全部验证的比例。",
    },
    {
      key: "terminal-wip",
      label: "周期终态 / 已记录非终态",
      value: `${current.terminalTasks ?? "不可判定"} / ${current.recordedActiveTasks ?? "不可判定"}`,
      detail: current.periodEndWipStatus === "available"
        ? `严格期末 WIP ${current.periodEndWipTasks} 个 · 截至 ${formatDateTime(current.periodEndAt)}`
        : current.periodEndWipStatus === "missing_started_at"
          ? `严格期末 WIP 暂不可计算 · ${current.periodEndWipUnresolvedTasks} 个候选实例缺少启动时间`
          : current.periodEndWipStatus === "missing_observation"
            ? "严格期末 WIP 暂不可计算 · 缺少范围观测时间"
            : current.periodEndWipStatus === "observation_before_range"
              ? `严格期末 WIP 暂不可计算 · 最近观测 ${formatDateTime(current.periodEndAt)} 早于查询周期`
              : current.periodEndWipStatus === "partial_coverage"
                ? "严格期末 WIP 暂不可计算 · 来源覆盖不完整"
                : "当前服务尚未提供严格期末 WIP",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.terminalActiveSamples,
    },
    {
      key: "delivery-cycle",
      label: "交付周期 P50 / P90",
      value: `${formatDuration(current.medianDurationMs)} / ${formatDuration(current.p90DurationMs)}`,
      detail: `${current.durationSampleCount} 个终态样本 · P75 ${formatDuration(current.p75DurationMs)} · P95 ${formatDuration(current.p95DurationMs)} · 均值 ${formatDuration(currentSummary.cards.avgDurationMs)}`,
      definition: ORCHESTRATION_METRIC_DEFINITIONS.deliveryCycleTime,
    },
    {
      key: "flow-efficiency",
      label: "流动效率",
      value: current.flowEfficiency == null ? "不可判定" : formatRate(current.flowEfficiency),
      detail: flowDetail,
      definition: ORCHESTRATION_METRIC_DEFINITIONS.flowEfficiency,
    },
    {
      key: "data-quality",
      label: "数据质量",
      value: dataQualityOverviewStatusText.value,
      definition: ORCHESTRATION_METRIC_DEFINITIONS.dataQualityState,
    },
  ];
});
const freshnessStatus = computed(() => summary.value?.freshness.status ?? "empty");
const freshnessClass = computed(() => `orchestration-metrics__freshness--${freshnessStatus.value}`);
const freshnessUpdatedAt = computed(() => summary.value?.freshness.refreshedAt ?? summary.value?.freshness.generatedAt ?? null);
const summaryFactLimitReached = computed(() => summary.value?.dataQuality.reasons.some((reason) =>
  reason === "instance_limit" || reason === "node_limit" || reason === "quality_event_limit" || reason === "contract_fact_limit"
) === true);
const freshnessNoticeMessage = computed(() => String(summary.value?.freshness.message ?? "").trim());
const showFreshnessNotice = computed(() => Boolean(freshnessNoticeMessage.value)
  && freshnessNoticeMessage.value !== dismissedFreshnessMessage.value);

/** Keeps a dismissed freshness notice hidden until its content changes or the condition clears. */
function dismissFreshnessNotice(): void {
  dismissedFreshnessMessage.value = freshnessNoticeMessage.value;
}

watch(freshnessNoticeMessage, (next) => {
  if (!next || next !== dismissedFreshnessMessage.value) dismissedFreshnessMessage.value = "";
});
/** 将四维数据质量状态转换为概览卡可直接阅读的标签和值。 */
const dataQualityOverviewDimensions = computed(() => {
  const quality = summary.value?.dataQuality;
  if (!quality) return [];
  return [
    { key: "coverage", label: "范围", value: dataQualityOverviewDimensionLabel(quality.coverage) },
    { key: "completeness", label: "证据", value: dataQualityOverviewDimensionLabel(quality.completeness) },
    { key: "freshness", label: "时效", value: dataQualityOverviewDimensionLabel(quality.freshness) },
    { key: "consistency", label: "一致", value: dataQualityOverviewDimensionLabel(quality.consistency) },
  ];
});
/** 保留完整的可访问文本，视觉层使用同一横排的四个带标签状态。 */
const dataQualityOverviewStatusText = computed(() => {
  if (dataQualityOverviewDimensions.value.length === 0) return "旧版合同";
  return dataQualityOverviewDimensions.value
    .map((item) => `${item.label}：${item.value}`)
    .join("｜");
});
const viewState = computed(() => resolveOrchestrationMetricsViewState({
  loading: loading.value,
  errorMessage: errorMessage.value,
  hasSummary: Boolean(summary.value),
  totalTasks: cards.value?.totalTasks ?? 0,
}));
const showEmpty = computed(() => viewState.value === "empty");
/**
 * 编排度量与交付效能是两套独立口径：编排执行记录为空时，交付事实（commit/PR/测试/部署）
 * 仍可能有数据，反之亦然。空态下先预检一次交付效能，只在确有数据时才展示跨口径入口，
 * 避免把用户引导到同样为空的视图。
 */
const deliveryEntryState = ref<"idle" | "probing" | "available" | "empty">("idle");
let deliveryEntryProbeVersion = 0;
const emptyDescription = computed(() => deliveryEntryState.value === "empty"
  ? "当前筛选范围暂无编排度量数据，交付效能也暂无数据"
  : "当前筛选范围暂无编排度量数据");

/** 预检交付效能对当前查询范围是否有数据；预检失败无法判定为空，保守保留入口并由该页自行报错。 */
async function probeDeliveryEntry(): Promise<void> {
  const requestVersion = ++deliveryEntryProbeVersion;
  if (!showEmpty.value || !componentActive) {
    deliveryEntryState.value = "idle";
    return;
  }
  deliveryEntryState.value = "probing";
  const result = await getOrchestrationMetricDelivery(ctx.value, buildQueryFilters(1, 1));
  if (requestVersion !== deliveryEntryProbeVersion || !componentActive) return;
  deliveryEntryState.value = !result.ok || result.total > 0 ? "available" : "empty";
}

const maxTrendTotal = computed(() => Math.max(1, ...(summary.value?.trend ?? []).map((item) => item.totalTasks)));
const TREND_CHART = { minWidth: 640, height: 260, left: 48, right: 20, top: 18, bottom: 38 } as const;
const trendChartWidth = ref<number>(TREND_CHART.minWidth);
let trendResizeObserver: ResizeObserver | null = null;
type TrendChartPoint = {
  index: number;
  bucket: OrchestrationMetricSummary["trend"][number];
  x: number;
  yTotal: number;
  ySuccess: number;
  showLabel: boolean;
};
const trendChartMax = computed(() => Number(scaleLinear().domain([0, maxTrendTotal.value]).nice(4).domain()[1] ?? maxTrendTotal.value));
const trendChartPoints = computed<TrendChartPoint[]>(() => {
  const buckets = summary.value?.trend ?? [];
  const plotWidth = trendChartWidth.value - TREND_CHART.left - TREND_CHART.right;
  const plotHeight = TREND_CHART.height - TREND_CHART.top - TREND_CHART.bottom;
  const labelStep = Math.max(1, Math.ceil(buckets.length / 7));
  return buckets.map((bucket, index) => {
    const x = buckets.length <= 1
      ? TREND_CHART.left + plotWidth / 2
      : TREND_CHART.left + index * plotWidth / (buckets.length - 1);
    const toY = (value: number) => TREND_CHART.top + (1 - value / trendChartMax.value) * plotHeight;
    return {
      index,
      bucket,
      x,
      yTotal: toY(bucket.totalTasks),
      ySuccess: toY(bucket.successfulTasks ?? 0),
      showLabel: index % labelStep === 0 || index === buckets.length - 1,
    };
  });
});
const trendYAxisTicks = computed(() => {
  const values = [...new Set([0, ...scaleLinear().domain([0, trendChartMax.value]).ticks(4).filter(Number.isInteger), trendChartMax.value])]
    .sort((left, right) => left - right);
  return values.map((value) => ({
    value,
    y: TREND_CHART.top + (1 - value / trendChartMax.value) * (TREND_CHART.height - TREND_CHART.top - TREND_CHART.bottom),
  }));
});
const trendTotalPath = computed(() => buildTrendLinePath(trendChartPoints.value, "yTotal"));
const trendSuccessPath = computed(() => buildTrendLinePath(trendChartPoints.value, "ySuccess"));
const trendHitWidth = computed(() => (trendChartWidth.value - TREND_CHART.left - TREND_CHART.right)
  / Math.max(1, trendChartPoints.value.length - 1));
const hoveredTrendPoint = computed(() => hoveredTrendIndex.value == null ? null : trendChartPoints.value[hoveredTrendIndex.value] ?? null);
const overviewTokenTrendSeries: OrchestrationMetricLineChartSeries[] = [
  { key: "uncachedInputTokens", label: "未命中缓存输入", color: "#2563eb", unit: "count" },
  { key: "cachedInputTokens", label: "命中缓存输入", color: "#7c3aed", unit: "count" },
  { key: "outputTokens", label: "输出 Token", color: "#059669", unit: "count" },
  { key: "totalTokens", label: "总 Token", color: "#d97706", unit: "count" },
];
const overviewCodeTrendSeries: OrchestrationMetricLineChartSeries[] = [
  { key: "aiGeneratedAddedLines", label: "AI 生成行", color: "#2563eb", unit: "count" },
  { key: "retainedAiAddedLines", label: "AI 采纳行", color: "#059669", unit: "count" },
  { key: "committedAddedLines", label: "提交新增行", color: "#d97706", unit: "count" },
  { key: "coveredCommittedAddedLines", label: "完整覆盖行", color: "#0891b2", unit: "count" },
];
const overviewSpecificationTrendSeries: OrchestrationMetricLineChartSeries[] = [
  { key: "gate", label: "Gate 覆盖", color: "#2f6f6d", unit: "rate" },
  { key: "artifact", label: "Artifact 覆盖", color: "#4472a8", unit: "rate" },
  { key: "acceptance", label: "验收标准覆盖", color: "#b26a2f", unit: "rate" },
  { key: "runtime_evidence", label: "运行证据覆盖", color: "#7a5a9a", unit: "rate" },
];
const overviewTrendMeta = computed(() => `${trendBucketUnitLabel(summary.value?.bucketUnit)} · ${trendTimezoneLabel(summary.value?.filters.timezone)}`);
const overviewTokenTrendPoints = computed<OrchestrationMetricLineChartPoint[]>(() => (costs.value?.trend ?? []).map((bucket) => ({
  key: bucket.bucketStart,
  label: formatBucketLabel(bucket.bucketStart),
  values: {
    uncachedInputTokens: bucket.uncachedInputTokens,
    cachedInputTokens: bucket.cachedInputTokens,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.totalTokens,
  },
  protected: bucket.privacy?.status === "suppressed",
})));
const overviewCodeTrendPoints = computed<OrchestrationMetricLineChartPoint[]>(() => (codeAttribution.value?.trend ?? []).map((bucket) => ({
  key: bucket.bucketStart,
  label: formatBucketLabel(bucket.bucketStart),
  values: {
    aiGeneratedAddedLines: bucket.aiGeneratedAddedLines,
    retainedAiAddedLines: bucket.retainedAiAddedLines,
    committedAddedLines: bucket.committedAddedLines,
    coveredCommittedAddedLines: bucket.coveredCommittedAddedLines,
  },
  protected: bucket.privacy?.status === "suppressed",
})));
const overviewSpecificationTrendPoints = computed<OrchestrationMetricLineChartPoint[]>(() => (summary.value?.specificationTrend ?? []).map((bucket) => ({
  key: bucket.bucketStart,
  label: formatBucketLabel(bucket.bucketStart),
  values: Object.fromEntries(overviewSpecificationTrendSeries.map((series) => [
    series.key,
    bucket.categories.find((category) => category.category === series.key)?.coverageRate ?? null,
  ])),
  protected: bucket.privacy?.status === "suppressed",
})));
const correlationMetricPresentation: Record<OrchestrationMetricCorrelationMetric, { label: string; axisLabel: string; scale: "linear" | "log" }> = {
  duration: { label: "任务总耗时", axisLabel: "任务总耗时", scale: "log" },
  rework: { label: "返工次数", axisLabel: "返工次数", scale: "linear" },
  review_rejection: { label: "评审驳回次数", axisLabel: "评审驳回次数", scale: "linear" },
  validation_failure: { label: "验证失败", axisLabel: "验证失败（0=通过，1=失败）", scale: "linear" },
};
const correlationMetricOptions = ORCHESTRATION_METRIC_CORRELATION_METRICS.map((value) => ({
  value,
  label: correlationMetricPresentation[value].label,
}));
const responseCorrelationXMetric = computed(() => correlations.value?.xMetric ?? correlationXMetric.value);
const responseCorrelationYMetric = computed(() => correlations.value?.yMetric ?? correlationYMetric.value);
const correlationXPresentation = computed(() => correlationMetricPresentation[responseCorrelationXMetric.value]);
const correlationYPresentation = computed(() => correlationMetricPresentation[responseCorrelationYMetric.value]);
const scatterMaxX = computed(() => Math.max(0, ...(correlations.value?.points ?? []).map((point) => point.x)));
const scatterMaxY = computed(() => Math.max(0, ...(correlations.value?.points ?? []).map((point) => point.y)));
const scatterPoints = computed(() => {
  const points = sampleOrchestrationMetricCorrelationPoints(correlations.value?.points ?? []);
  const xScale = correlationXPresentation.value.scale === "log"
    ? scaleLog().domain([1, Math.max(2, scatterMaxX.value)]).range([3, 97]).clamp(true)
    : scaleLinear().domain([0, Math.max(1, scatterMaxX.value)]).range([3, 97]).clamp(true);
  const yScale = correlationYPresentation.value.scale === "log"
    ? scaleLog().domain([1, Math.max(2, scatterMaxY.value)]).range([6, 94]).clamp(true)
    : scaleLinear().domain([0, Math.max(1, scatterMaxY.value)]).range([6, 94]).clamp(true);
  return points.map((point) => ({ ...point, left: xScale(point.x), bottom: yScale(point.y) }));
});
const correlationSampleCount = computed(() => correlations.value?.sampleStats.validSampleCount ?? 0);
const correlationTotalSampleCount = computed(() => correlations.value?.sampleStats.totalSampleCount ?? 0);
const correlationExcludedSampleCount = computed(() => correlations.value?.sampleStats.excludedSampleCount ?? 0);
const scatterPointCount = computed(() => scatterPoints.value.length);
const correlationTitle = computed(() => `${correlationXPresentation.value.label}与${correlationYPresentation.value.label}关联`);
const correlationXAxisTitle = computed(() => `${correlationXPresentation.value.axisLabel}${correlationXPresentation.value.scale === "log" ? "（对数刻度）" : ""}`);
const correlationYAxisTitle = computed(() => `${correlationYPresentation.value.axisLabel}${correlationYPresentation.value.scale === "log" ? "（对数刻度）" : ""}`);
const bottleneckComponentPresentation: Record<OrchestrationMetricBottleneckComponentSignal, { label: string; kind: "duration" | "rate" }> = {
  active_duration: { label: "活跃耗时", kind: "duration" },
  wait_duration: { label: "等待耗时", kind: "duration" },
  first_pass_rate: { label: "首次通过率", kind: "rate" },
  rework_rate: { label: "返工率", kind: "rate" },
  review_rejection_rate: { label: "评审驳回率", kind: "rate" },
  gate_validation_failure_rate: { label: "Gate/验证失败率", kind: "rate" },
};
const bottleneckComponentOrder = Object.keys(bottleneckComponentPresentation) as OrchestrationMetricBottleneckComponentSignal[];
const flowBreakdownItems = computed(() => (flow.value?.breakdown ?? []).filter((item) =>
  item.sampleCount > 0 && ((item.durationMs !== null && item.durationMs > 0) || item.privacy?.status === "suppressed")));
const flowBarBreakdownItems = computed(() => flowBreakdownItems.value.filter((item) => item.durationMs !== null && item.durationMs > 0));
const flowSegmentLimitReached = computed(() => flow.value?.metadata.partialReasons.includes("state_segment_limit") === true);
/** Maps server-owned closed-instance distributions to the compact flow table. */
const flowDurationDistributionRows = computed(() => {
  const distributions = flow.value?.durationDistributions;
  if (!distributions) return [];
  return [
    { key: "wallClock", label: "墙钟", distribution: distributions.wallClock },
    { key: "active", label: "活跃", distribution: distributions.active },
    { key: "humanWait", label: "人工等待", distribution: distributions.humanWait },
    { key: "queue", label: "排队", distribution: distributions.queue },
    { key: "paused", label: "暂停", distribution: distributions.paused },
    { key: "unclassified", label: "未分类", distribution: distributions.unclassified },
  ];
});

/** 将相关系数转换为业务可读的方向和强度。 */
function describeCorrelation(value: number | null | undefined): string {
  if (value == null) return "不可计算";
  const strength = Math.abs(value) < 0.2 ? "几乎无相关" : Math.abs(value) < 0.4 ? "弱相关" : Math.abs(value) < 0.6 ? "中等相关" : Math.abs(value) < 0.8 ? "较强相关" : "强相关";
  if (Math.abs(value) < 0.2) return strength;
  return `${strength} · ${value > 0 ? "正向" : "反向"}`;
}

/** Formats one correlation metric with its public display unit. */
function formatCorrelationMetricValue(metric: OrchestrationMetricCorrelationMetric, value: number): string {
  if (metric === "duration") return formatDuration(value);
  if (metric === "validation_failure") return value >= 1 ? "失败 (1)" : "通过 (0)";
  return `${value} 次`;
}

/** Builds the point tooltip from the response-owned X/Y metric identities. */
function formatCorrelationPointTitle(point: { workflowName: string; x: number; y: number }): string {
  return `${point.workflowName}: ${correlationXPresentation.value.label} ${formatCorrelationMetricValue(responseCorrelationXMetric.value, point.x)} / ${correlationYPresentation.value.label} ${formatCorrelationMetricValue(responseCorrelationYMetric.value, point.y)}`;
}

/** Maps server-owned bottleneck components to compact display rows without recomputing risk. */
function bottleneckComponentRows(item: OrchestrationMetricBottleneckItem) {
  return bottleneckComponentOrder.map((signal) => {
    const presentation = bottleneckComponentPresentation[signal];
    const component = item.components?.[signal];
    const value = component?.value ?? null;
    const baseline = component?.baseline ?? null;
    const status = component?.status ?? "missing_facts";
    const valueText = presentation.kind === "duration"
      ? `P90 ${formatDuration(value)} / P50 ${formatDuration(baseline)}`
      : formatRate(value);
    const statusText = status === "available" ? "可计算" : status === "insufficient_samples" ? "样本不足" : "事实缺失";
    return {
      signal,
      label: presentation.label,
      valueText,
      status,
      statusText,
      riskPercent: component?.riskScore == null ? null : Math.round(component.riskScore * 100),
      detail: `${component?.sampleCount ?? 0} 个样本 · 权重 ${Math.round((component?.weight ?? 0) * 100)}%`,
    };
  });
}

/** Describes the server-owned composite ranking state without inferring a score. */
function bottleneckRankingText(item: OrchestrationMetricBottleneckItem): string {
  if (item.privacy?.status === "suppressed") return "受小群体保护";
  if (item.rankingStatus === "ranked") return `综合分 ${Math.round((item.score ?? 0) * 100)}`;
  if (item.rankingStatus === "incomplete_signals") return "必需信号事实不完整";
  if (item.rankingStatus === "version_unavailable") return "历史版本不可比较";
  return "必需信号样本不足";
}

/** 根据 Pearson 与 Spearman 给出当前结果的简洁业务结论。 */
const correlationConclusion = computed(() => {
  const xLabel = correlationXPresentation.value.label;
  const yLabel = correlationYPresentation.value.label;
  if (correlationLoading.value) return `正在加载${xLabel}与${yLabel}的相关性结果。`;
  if (correlations.value?.calculationStatus === "insufficient_samples") {
    return `当前有效样本不足 20 个，暂时无法判断${xLabel}与${yLabel}是否存在稳定关联。`;
  }
  if (correlations.value?.calculationStatus === "zero_variance") {
    return `当前有效样本已达到门槛，但${xLabel}或${yLabel}没有变化，无法计算相关系数。`;
  }
  const pearson = correlations.value?.pearson;
  const spearmanValue = correlations.value?.spearman;
  if (pearson == null || spearmanValue == null) return "当前相关性结果不可计算，请结合数据状态检查样本。";
  if (responseCorrelationXMetric.value === responseCorrelationYMetric.value) {
    return `当前选择了同一项${xLabel}进行自比较；结果只用于核对指标一致性，不提供指标之间的关联或因果结论。`;
  }
  const strongest = Math.abs(pearson) >= Math.abs(spearmanValue) ? pearson : spearmanValue;
  if (Math.abs(strongest) < 0.2) return `当前结果显示${xLabel}与${yLabel}几乎没有稳定关联；该结果不代表两者之间存在因果关系。`;
  const direction = strongest > 0 ? "同向" : "反向";
  const strength = describeCorrelation(strongest).split(" · ")[0];
  return `当前结果呈${strength}，${xLabel}与${yLabel}整体${direction}变化；该结果用于发现线索，不代表两者之间存在因果关系。`;
});

function readQueryValue(key: string): string | null {
  const value = route.query[key];
  return typeof value === "string" && value ? value : null;
}

/** 恢复度量视图状态，并将已下线的明细 Tab 兼容回概览。 */
function restoreViewContext(): void {
  const scopeKind = readQueryValue("om_scope") as OrchestrationMetricScopeKind | null;
  if (scopeKind && scopes.value.some((scope) => scope.scopeKind === scopeKind && !scope.disabled)) selectedScopeKind.value = scopeKind;
  selectedScopeId.value = readQueryValue("om_scope_id") ?? selectedScope.value?.scopeId ?? null;
  const range = readQueryValue("om_range") as RangePreset | null;
  if (rangeOptions.some((option) => option.value === range)) filters.range = range!;
  const tab = readQueryValue("om_tab");
  const restoredCorrelationX = readQueryValue("om_correlation_x") as OrchestrationMetricCorrelationMetric | null;
  const restoredCorrelationY = readQueryValue("om_correlation_y") as OrchestrationMetricCorrelationMetric | null;
  if (restoredCorrelationX && ORCHESTRATION_METRIC_CORRELATION_METRICS.includes(restoredCorrelationX)) correlationXMetric.value = restoredCorrelationX;
  if (restoredCorrelationY && ORCHESTRATION_METRIC_CORRELATION_METRICS.includes(restoredCorrelationY)) correlationYMetric.value = restoredCorrelationY;
  focusedCohortKey.value = readQueryValue("om_cohort");
  const restoredExperimentView = readQueryValue("om_experiment_view") as ExperimentView | null;
  experimentView.value = focusedCohortKey.value
    ? "comparison"
    : restoredExperimentView === "workbench"
      ? "workbench"
      : restoredExperimentView === "controlled" && selectedScopeKind.value === "mine" ? "controlled" : "comparison";
  const restoredTab = tab === "details" ? "overview" : tab;
  const availableTabs = ["overview", "flow", "conformance", "costs", "code_attribution", "specification", "experiments", "delivery", "trend", "bottleneck", "correlation"];
  if (availableTabs.includes(restoredTab ?? "")) activeTab.value = restoredTab!;
  filters.workflowIds = readQueryValue("om_workflows")?.split(",").filter(Boolean) ?? [];
  filters.roleStages = readQueryValue("om_roles")?.split(",").filter(Boolean) ?? [];
  filters.models = readQueryValue("om_models")?.split(",").filter(Boolean) ?? [];
  const dimension = readQueryValue("om_dimension") as OrchestrationMetricFilters["dimension"];
  if (analysisDimensionOptions.some((option) => option.value === dimension)) filters.dimension = dimension!;
  const costDimension = readQueryValue("om_cost_dimension") as OrchestrationMetricCostDimension | null;
  if (costDimensionOptions.some((option) => option.value === costDimension)) filters.costDimension = costDimension!;
  const codeAttributionDimension = readQueryValue("om_code_dimension") as OrchestrationMetricCodeAttributionDimension | null;
  if (codeAttributionDimension && ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DIMENSIONS.includes(codeAttributionDimension)) {
    filters.codeAttributionDimension = codeAttributionDimension!;
  }
  filters.page = Math.max(1, Number(readQueryValue("om_page")) || 1);
  filters.pageSize = [20, 50, 100].includes(Number(readQueryValue("om_page_size"))) ? Number(readQueryValue("om_page_size")) : 20;
  if (tab === "details") syncViewContext();
}

/** Synchronizes current metric controls into the existing route query. */
function syncViewContext(): void {
  if (!viewContextReady) return;
  const nextQuery = { ...route.query } as Record<string, string | string[] | undefined>;
  const values: Record<string, string | undefined> = {
    om_scope: selectedScopeKind.value,
    om_scope_id: selectedScopeId.value ?? undefined,
    om_range: filters.range,
    om_tab: activeTab.value,
    om_correlation_x: correlationXMetric.value === "duration" ? undefined : correlationXMetric.value,
    om_correlation_y: correlationYMetric.value === "rework" ? undefined : correlationYMetric.value,
    om_experiment_view: activeTab.value === "experiments" && experimentView.value !== "comparison" ? experimentView.value : undefined,
    om_cohort: focusedCohortKey.value ?? undefined,
    om_workflows: filters.workflowIds.length ? filters.workflowIds.join(",") : undefined,
    om_versions: undefined,
    om_statuses: undefined,
    om_roles: filters.roleStages.length ? filters.roleStages.join(",") : undefined,
    om_models: filters.models.length ? filters.models.join(",") : undefined,
    om_dimension: filters.dimension === "workflow" ? undefined : filters.dimension,
    om_cost_dimension: filters.costDimension === "workflow" ? undefined : filters.costDimension,
    om_code_dimension: filters.codeAttributionDimension === "workflow" ? undefined : filters.codeAttributionDimension,
    om_page: filters.page > 1 ? String(filters.page) : undefined,
    om_page_size: filters.pageSize !== 20 ? String(filters.pageSize) : undefined,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete nextQuery[key]; else nextQuery[key] = value;
  }
  void router.replace({ query: nextQuery });
}

/** Loads authorized scopes and optionally applies the Server-owned default scope. */
async function loadScopes(applyDefaultScope = true): Promise<void> {
  const requestVersion = ++scopesRequestVersion;
  scopesLoading.value = true;
  try {
    const result = await getOrchestrationMetricScopes(ctx.value);
    if (requestVersion !== scopesRequestVersion || !componentActive) return;
    if (!handleApiError(result, "编排度量范围加载失败")) return;
    scopes.value = result.scopes.filter((scope) => ["mine", "shared_workspace", "enterprise"].includes(scope.scopeKind));
    if (applyDefaultScope) {
      const defaultScope = scopes.value.find((scope) => scope.scopeKind === result.defaultScope.scopeKind)
        ?? scopes.value.find((scope) => scope.scopeKind === "mine");
      selectedScopeKind.value = defaultScope?.scopeKind ?? "mine";
      selectedScopeId.value = defaultScope?.scopeId ?? null;
    }
  } finally {
    if (requestVersion === scopesRequestVersion) scopesLoading.value = false;
  }
}

/** 新查询轮取消旧采集，重新校验当前授权范围的完整快照。 */
async function loadDashboard(): Promise<void> {
  metricRequestController.value.abort();
  metricRequestController.value = new AbortController();
  clearOrchestrationMetricQueryCache();
  const requestVersion = ++dashboardRequestVersion;
  const flowVersion = ++flowRequestVersion;
  const shouldLoadConformance = activeTab.value === "conformance";
  const shouldLoadCosts = activeTab.value === 'costs' || activeTab.value === 'overview';
  const shouldLoadExperiments = activeTab.value === "experiments" && experimentView.value === "comparison";
  const shouldLoadEvaluationSets = activeTab.value === "experiments" && experimentView.value !== "comparison";
  const shouldLoadDelivery = activeTab.value === "delivery";
  const shouldLoadCodeAttribution = activeTab.value === "code_attribution" || activeTab.value === 'overview';
  const conformanceVersion = ++conformanceRequestVersion;
  const costsVersion = ++costsRequestVersion;
  const experimentsVersion = ++experimentsRequestVersion;
  const evaluationSetsVersion = ++evaluationSetsRequestVersion;
  const deliveryVersion = ++deliveryRequestVersion;
  const codeAttributionVersion = ++codeAttributionRequestVersion;
  flowPage.value = 1;
  conformancePage.value = 1;
  costsPage.value = 1;
  deliveryPage.value = 1;
  codeAttributionPage.value = 1;
  experimentsPage.value = 1;
  correlationRequestVersion += 1;
  correlationLoading.value = false;
  experimentsError.value = "";
  focusedCohortMissing.value = false;
  evaluationSetsLoading.value = false;
  evaluationSetsError.value = "";
  deliveryError.value = "";
  costsError.value = "";
  if (!canQuery.value) {
    summary.value = null;
    codeAttribution.value = null;
    codeAttributionError.value = "";
    summaryLoading.value = false;
    analysisLoading.value = false;
    flowLoading.value = false;
    conformanceLoading.value = false;
    costsLoading.value = false;
    experimentsLoading.value = false;
    deliveryLoading.value = false;
    codeAttributionLoading.value = false;
    return;
  }
  captureActiveQuerySnapshot();
  const nextContextKey = buildMetricCacheContextKey();
  if (renderedMetricContextKey && renderedMetricContextKey !== nextContextKey) resetLazyMetricViewsForContextChange();
  renderedMetricContextKey = nextContextKey;
  closeNodeExecutions();
  closeContractDetails();
  errorMessage.value = "";
  errorCode.value = "";
  const requests = [
    loadSummary(requestVersion),
    loadDeepAnalysis(requestVersion),
    loadFlow(flowVersion),
  ];
  if (shouldLoadConformance) requests.push(loadConformance(conformanceVersion));
  if (shouldLoadCosts) requests.push(loadCosts(costsVersion));
  if (shouldLoadExperiments) requests.push(loadExperiments(experimentsVersion));
  if (shouldLoadEvaluationSets) requests.push(loadEvaluationSets(evaluationSetsVersion));
  if (shouldLoadDelivery) requests.push(loadDelivery(deliveryVersion));
  if (shouldLoadCodeAttribution) requests.push(loadCodeAttribution(codeAttributionVersion));
  await Promise.all(requests);
  if (requestVersion !== dashboardRequestVersion || !componentActive) return;
  void probeDeliveryEntry();
}

/** Clears lazy Tab state when the applied business context changes, before matching cache reads run. */
function resetLazyMetricViewsForContextChange(): void {
  conformance.value = null;
  conformanceError.value = "";
  conformanceCompatibilityUnavailable.value = false;
  costs.value = null;
  experiments.value = null;
  experimentsError.value = "";
  evaluationSets.value = [];
  evaluationSetsLoaded.value = false;
  evaluationSetsError.value = "";
  selectedEvaluationSet.value = null;
  evaluationSetItems.value = [];
  delivery.value = null;
  deliveryError.value = "";
  costsError.value = "";
  codeAttribution.value = null;
  codeAttributionError.value = "";
}

/** Loads one process-conformance page against the frozen dashboard query. */
async function loadConformance(requestVersion = conformanceRequestVersion): Promise<void> {
  if (requestVersion !== conformanceRequestVersion) return;
  const queryFilters = buildQueryFilters(conformancePage.value, conformancePageSize.value);
  const cached = resolveMetricQuery("conformance", { page: conformancePage.value, pageSize: conformancePageSize.value },
    () => getOrchestrationMetricConformance(ctx.value, queryFilters));
  const hasCached = cached.state !== "miss";
  conformanceError.value = "";
  conformanceCompatibilityUnavailable.value = false;
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricConformance>>): void => {
    if (!result.ok) {
      if (String(result.code) === "FST_ERR_NOT_FOUND" || result.message.includes("Route GET:/api/account/orchestration-metrics/conformance")) {
        conformanceCompatibilityUnavailable.value = true;
        return;
      }
      conformanceError.value = result.message || "流程符合性加载失败";
      message.error(conformanceError.value);
      return;
    }
    conformance.value = result;
    conformancePage.value = result.page;
    conformancePageSize.value = result.pageSize;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) conformanceLoading.value = false;
  if (!cached.refresh) return;
  conformanceLoading.value = !hasCached;
  if (!hasCached) conformance.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== conformanceRequestVersion) return;
    commit(result);
  } finally {
    if (requestVersion === conformanceRequestVersion) conformanceLoading.value = false;
  }
}

/** Loads one flow page and commits it only while its dashboard request is current. */
async function loadFlow(requestVersion = flowRequestVersion): Promise<void> {
  if (requestVersion !== flowRequestVersion) return;
  const queryFilters = buildFlowQueryFilters();
  const cached = resolveMetricQuery("flow", { page: flowPage.value, pageSize: flowPageSize.value },
    () => getOrchestrationMetricFlow(ctx.value, queryFilters));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricFlow>>): void => {
    if (!handleApiError(result, "流程效率加载失败")) return;
    flow.value = result;
    flowPage.value = result.page;
    flowPageSize.value = result.pageSize;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) flowLoading.value = false;
  if (!cached.refresh) return;
  flowLoading.value = !hasCached;
  if (!hasCached) flow.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== flowRequestVersion) return;
    commit(result);
  } finally {
    if (requestVersion === flowRequestVersion) flowLoading.value = false;
  }
}

/** Loads one Agent Trace page while keeping cost aggregates scoped to all matching facts. */
async function loadCosts(requestVersion = costsRequestVersion): Promise<void> {
  if (requestVersion !== costsRequestVersion) return;
  const requestId = createBrowserUuid();
  costsError.value = "";
  const queryFilters = buildQueryFilters(costsPage.value, costsPageSize.value);
  const cached = resolveMetricQuery("costs", { page: costsPage.value, pageSize: costsPageSize.value, costDimension: queryFilters.costDimension },
    () => getOrchestrationMetricCosts(ctx.value, queryFilters));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricCosts>>): void => {
    if (!result.ok) {
      costsError.value = "当前无法加载 Token 消耗数据，请稍后重试。";
      console.error("[OrchestrationMetricsPanel] token cost load failed", {
        errorCode: String(result.code ?? "ORCH_METRICS_COSTS_LOAD_FAILED"),
        requestId,
        scopeKind: queryFilters.scopeKind,
        scopeId: queryFilters.scopeId,
        dimension: queryFilters.costDimension,
        page: queryFilters.page,
        cause: result.message,
      });
      return;
    }
    costsError.value = "";
    costs.value = result;
    costsPage.value = result.page;
    costsPageSize.value = result.pageSize;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) costsLoading.value = false;
  if (!cached.refresh) return;
  costsLoading.value = !hasCached;
  if (!hasCached) costs.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== costsRequestVersion) return;
    commit(result);
  } catch (error) {
    if (requestVersion !== costsRequestVersion) return;
    costsError.value = "当前无法加载 Token 消耗数据，请检查网络后重试。";
    console.error("[OrchestrationMetricsPanel] token cost request failed", {
      errorCode: "ORCH_METRICS_COSTS_REQUEST_FAILED",
      requestId,
      scopeKind: queryFilters.scopeKind,
      scopeId: queryFilters.scopeId,
      dimension: queryFilters.costDimension,
      page: queryFilters.page,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (requestVersion === costsRequestVersion) costsLoading.value = false;
  }
}

/** Reloads the selected cost dimension while preserving all applied business filters. */
function handleCostDimensionChange(value: string | number): void {
  if (!costDimensionOptions.some((option) => option.value === value)) return;
  const costDimension = value as OrchestrationMetricCostDimension;
  filters.costDimension = costDimension;
  if (activeQuerySnapshot) activeQuerySnapshot = { ...activeQuerySnapshot, costDimension };
  else captureActiveQuerySnapshot();
  costsPage.value = 1;
  void loadCosts(++costsRequestVersion);
}

/** Loads exact-version evaluation cohorts for the selected current and previous periods. */
async function loadExperiments(requestVersion = experimentsRequestVersion): Promise<void> {
  if (requestVersion !== experimentsRequestVersion) return;
  experimentsError.value = "";
  const query: OrchestrationMetricFilters = {
    ...buildQueryFilters(),
    page: experimentsPage.value,
    pageSize: experimentsPageSize.value,
    evaluationCriteria: experimentCriteria.value,
    experimentComparability: experimentComparability.value,
    experimentCohortKey: focusedCohortKey.value,
  };
  if (query.from == null || query.to == null) {
    experiments.value = null;
    experimentsLoading.value = false;
    experimentsError.value = "评估实验需要明确时间范围，请选择最近 7 天、30 天或 90 天。";
    return;
  }
  const cacheInput = {
    page: experimentsPage.value,
    pageSize: experimentsPageSize.value,
    evaluationCriteria: experimentCriteria.value,
    experimentComparability: experimentComparability.value,
    experimentCohortKey: focusedCohortKey.value,
  };
  const cached = resolveMetricQuery("experiments", cacheInput, () => getOrchestrationMetricExperiments(ctx.value, query));
  const hasCached = cached.state !== "miss";
  const commit = async (result: Awaited<ReturnType<typeof getOrchestrationMetricExperiments>>): Promise<void> => {
    if (!result.ok) {
      const routeMissing = String(result.code) === "FST_ERR_NOT_FOUND"
        || result.message.includes("Route GET:/api/account/orchestration-metrics/experiments");
      experimentsError.value = routeMissing ? "当前 Server 尚未加载评估实验接口。" : result.message || "评估实验加载失败";
      return;
    }
    experiments.value = result;
    experimentsPage.value = result.page;
    experimentsPageSize.value = result.pageSize;
    focusedCohortMissing.value = Boolean(focusedCohortKey.value)
      && !result.cohorts.some((cohort) => cohort.cohortKey === focusedCohortKey.value);
    await nextTick();
    if (focusedCohortKey.value) {
      document.querySelector<HTMLElement>(`[data-cohort-key="${CSS.escape(focusedCohortKey.value)}"]`)?.scrollIntoView({ block: "center" });
    }
  };
  if (cached.value) await commit(cached.value);
  if (hasCached) experimentsLoading.value = false;
  if (!cached.refresh) return;
  experimentsLoading.value = !hasCached;
  if (!hasCached) experiments.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== experimentsRequestVersion) return;
    await commit(result);
  } finally {
    if (requestVersion === experimentsRequestVersion) experimentsLoading.value = false;
  }
}

/** Loads reconciled delivery outcomes and DORA measures for the applied dashboard query. */
async function loadDelivery(requestVersion = deliveryRequestVersion): Promise<void> {
  if (requestVersion !== deliveryRequestVersion) return;
  deliveryError.value = "";
  const queryFilters = buildQueryFilters(deliveryPage.value, deliveryPageSize.value);
  const cached = resolveMetricQuery("delivery", { page: deliveryPage.value, pageSize: deliveryPageSize.value },
    () => getOrchestrationMetricDelivery(ctx.value, queryFilters));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricDelivery>>): void => {
    if (!result.ok) {
      const routeMissing = String(result.code) === "FST_ERR_NOT_FOUND"
        || result.message.includes("Route GET:/api/account/orchestration-metrics/delivery");
      deliveryError.value = routeMissing ? "当前 Server 尚未加载交付效能接口。" : result.message || "交付效能加载失败";
      return;
    }
    delivery.value = result;
    deliveryPage.value = result.page;
    deliveryPageSize.value = result.pageSize;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) deliveryLoading.value = false;
  if (!cached.refresh) return;
  deliveryLoading.value = !hasCached;
  if (!hasCached) delivery.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== deliveryRequestVersion) return;
    commit(result);
  } finally {
    if (requestVersion === deliveryRequestVersion) deliveryLoading.value = false;
  }
}

/** Loads one code-contribution page without exposing transport diagnostics in the page. */
async function loadCodeAttribution(requestVersion = codeAttributionRequestVersion): Promise<void> {
  if (requestVersion !== codeAttributionRequestVersion) return;
  const requestId = createBrowserUuid();
  codeAttributionError.value = "";
  const queryFilters = buildQueryFilters(codeAttributionPage.value, codeAttributionPageSize.value);
  const cacheInput = {
    page: codeAttributionPage.value,
    pageSize: codeAttributionPageSize.value,
    dimension: queryFilters.codeAttributionDimension,
  };
  const cached = resolveMetricQuery("code-attribution", cacheInput,
    () => getOrchestrationMetricCodeAttribution(ctx.value, queryFilters));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricCodeAttribution>>): void => {
    if (!result.ok) {
      codeAttributionError.value = "当前无法加载代码贡献数据，请稍后重试。";
      console.error("[OrchestrationMetricsPanel] code attribution load failed", {
        errorCode: String((result as { code?: unknown }).code ?? "ORCH_METRICS_CODE_ATTRIBUTION_LOAD_FAILED"),
        requestId,
        scopeKind: queryFilters.scopeKind,
        scopeId: queryFilters.scopeId,
        dimension: queryFilters.codeAttributionDimension,
        page: queryFilters.page,
        cause: result.message,
      });
      return;
    }
    codeAttribution.value = result;
    codeAttributionPage.value = result.page;
    codeAttributionPageSize.value = result.pageSize;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) codeAttributionLoading.value = false;
  if (!cached.refresh) return;
  codeAttributionLoading.value = !hasCached;
  if (!hasCached) codeAttribution.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== codeAttributionRequestVersion) return;
    commit(result);
  } catch (error) {
    if (requestVersion !== codeAttributionRequestVersion) return;
    codeAttributionError.value = "当前无法加载代码贡献数据，请检查网络后重试。";
    console.error("[OrchestrationMetricsPanel] code attribution request failed", {
      errorCode: "ORCH_METRICS_CODE_ATTRIBUTION_REQUEST_FAILED",
      requestId,
      scopeKind: queryFilters.scopeKind,
      scopeId: queryFilters.scopeId,
      dimension: queryFilters.codeAttributionDimension,
      page: queryFilters.page,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (requestVersion === codeAttributionRequestVersion) codeAttributionLoading.value = false;
  }
}

/** Reloads code contribution after a validated analysis-dimension change. */
function handleCodeAttributionDimensionChange(value: OrchestrationMetricCodeAttributionDimension): void {
  if (!ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DIMENSIONS.includes(value)) return;
  filters.codeAttributionDimension = value;
  if (activeQuerySnapshot) activeQuerySnapshot = { ...activeQuerySnapshot, codeAttributionDimension: value };
  else captureActiveQuerySnapshot();
  codeAttributionPage.value = 1;
  void loadCodeAttribution(++codeAttributionRequestVersion);
}

/** Loads the requested server-owned commit page while preserving the applied scope. */
function handleCodeAttributionPageChange(page: number, pageSize: number): void {
  codeAttributionPage.value = page;
  codeAttributionPageSize.value = pageSize;
  void loadCodeAttribution(++codeAttributionRequestVersion);
}

/** Opens the exact orchestration attempt referenced by one attributed commit. */
async function openCodeAttributionEvidence(
  item: OrchestrationMetricCodeAttributionCommitItem,
  reference: OrchestrationMetricCodeAttributionExecutionRef,
): Promise<void> {
  await openMetricEvidence(item.instanceId, item.routeTarget, reference.nodeId, reference.attemptNo, reference.promptSnapshotId);
}

/** Loads evaluation manifests for the current frozen scope and filters. */
async function loadEvaluationSets(requestVersion = evaluationSetsRequestVersion): Promise<void> {
  if (requestVersion !== evaluationSetsRequestVersion) return;
  const cached = resolveMetricQuery("evaluation-sets", {}, () => getOrchestrationMetricEvaluationSets(ctx.value, buildQueryFilters()));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricEvaluationSets>>): void => {
    if (!result.ok) {
      evaluationSetsError.value = result.message || "评估集加载失败";
      message.error(evaluationSetsError.value);
      return;
    }
    evaluationSetsError.value = "";
    evaluationSets.value = result.items;
    evaluationSetsLoaded.value = true;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) evaluationSetsLoading.value = false;
  if (!cached.refresh) return;
  evaluationSetsLoading.value = !hasCached;
  if (!hasCached) {
    evaluationSets.value = [];
    evaluationSetsLoaded.value = false;
  }
  try {
    const result = await cached.refresh;
    if (requestVersion !== evaluationSetsRequestVersion) return;
    commit(result);
  } finally {
    if (requestVersion === evaluationSetsRequestVersion) evaluationSetsLoading.value = false;
  }
}

/** Applies experiment filters and returns to the first server-paged cohort slice. */
function handleExperimentFiltersChange(): void {
  experimentsPage.value = 1;
  focusedCohortKey.value = null;
  focusedCohortMissing.value = false;
  void loadExperiments(++experimentsRequestVersion);
}

/** Changes the experiment page without affecting the dashboard detail pagination. */
function handleExperimentPageChange(page: number, pageSize: number): void {
  experimentsPage.value = pageSize === experimentsPageSize.value ? page : 1;
  experimentsPageSize.value = pageSize;
  focusedCohortKey.value = null;
  focusedCohortMissing.value = false;
  void loadExperiments(++experimentsRequestVersion);
}

/** Creates one deterministic evaluation manifest from the applied dashboard query. */
async function createEvaluationSet(): Promise<void> {
  const name = evaluationSetDraft.name.trim();
  if (!name) { message.warning("请输入评估集名称"); return; }
  evaluationSetCreating.value = true;
  try {
    const result = await createOrchestrationMetricEvaluationSet(ctx.value, { filters: buildQueryFilters(), kind: evaluationSetDraft.kind,
      name, description: "", criterion: evaluationSetDraft.criterion, sampleSize: evaluationSetDraft.sampleSize });
    if (!result.ok) { message.error(result.message || "评估集创建失败"); return; }
    evaluationSetDraft.name = "";
    clearOrchestrationMetricQueryCache();
    await loadEvaluationSets(++evaluationSetsRequestVersion);
    await openEvaluationSet(result);
    message.success("评估集已创建");
    trackProductEvent("orchestration_evaluation_set_change", {
      action: "create",
      kind: result.kind,
      criterion: result.criterion,
      sample_size: result.itemCount,
      scope_type: selectedScopeKind.value,
    });
  } finally { evaluationSetCreating.value = false; }
}

/** Opens one frozen evaluation set and loads its current item page. */
async function openEvaluationSet(item: OrchestrationMetricEvaluationSetSummary): Promise<void> {
  selectedEvaluationSet.value = item;
  evaluationSetItemPage.value = 1;
  await loadEvaluationSetItems();
}

/** Loads one server-paged evaluation-set slice. */
async function loadEvaluationSetItems(): Promise<void> {
  const set = selectedEvaluationSet.value;
  if (!set) return;
  evaluationSetItemsLoading.value = true;
  try {
    const result = await getOrchestrationMetricEvaluationSetItems(ctx.value, set.id, evaluationSetItemPage.value, evaluationSetItemPageSize.value);
    if (!result.ok) { message.error(result.message || "评估样本加载失败"); return; }
    selectedEvaluationSet.value = result.evaluationSet;
    evaluationSetItems.value = result.items;
    evaluationSetItemTotal.value = result.total;
  } finally { evaluationSetItemsLoading.value = false; }
}

/** Opens the explicit score editor for one frozen Trace sample. */
function openEvaluationScore(item: OrchestrationMetricEvaluationSetItem): void {
  evaluationScoreItem.value = item;
  evaluationScoreStatus.value = item.humanEvaluationStatus ?? "passed";
  evaluationScoreExplanation.value = item.humanExplanation ?? "";
  evaluationScoreOpen.value = true;
}

/** Saves a human score and refreshes both item and set summaries. */
async function saveEvaluationScore(): Promise<void> {
  const set = selectedEvaluationSet.value;
  const item = evaluationScoreItem.value;
  const explanation = evaluationScoreExplanation.value.trim();
  if (!set || !item || !explanation) { message.warning("请填写评分说明"); return; }
  evaluationScoreSaving.value = true;
  try {
    const result = await scoreOrchestrationMetricEvaluationSetItem(ctx.value, set.id, item.id, { evaluationStatus: evaluationScoreStatus.value, explanation });
    if (!result.ok) { message.error(result.message || "人工评分保存失败"); return; }
    evaluationScoreOpen.value = false;
    experimentsRequestVersion += 1;
    clearOrchestrationMetricQueryCache();
    experiments.value = null;
    await Promise.all([loadEvaluationSetItems(), loadEvaluationSets(++evaluationSetsRequestVersion)]);
    message.success("人工评分已保存");
    trackProductEvent("orchestration_evaluation_set_change", {
      action: "score",
      evaluation_status: evaluationScoreStatus.value,
      scope_type: selectedScopeKind.value,
    });
  } finally { evaluationScoreSaving.value = false; }
}

/** Loads all deep-analysis views as one versioned result set. */
async function loadDeepAnalysis(requestVersion = dashboardRequestVersion): Promise<void> {
  if (requestVersion !== dashboardRequestVersion) return;
  const analysisVersion = ++analysisRequestVersion;
  const correlationVersion = ++correlationRequestVersion;
  const query = buildQueryFilters();
  const analysisCached = resolveMetricQuery("analysis", { dimension: query.dimension },
    () => getOrchestrationMetricAnalysis(ctx.value, query));
  const bottleneckCached = resolveMetricQuery("bottlenecks", { signal: "composite" },
    () => getOrchestrationMetricBottlenecks(ctx.value, { ...query, signal: "composite" }));
  const isCurrent = (): boolean => requestVersion === dashboardRequestVersion && analysisVersion === analysisRequestVersion;
  const commitAnalysis = (result: Awaited<ReturnType<typeof getOrchestrationMetricAnalysis>>): void => {
    if (handleApiError(result, "趋势分析加载失败")) analysis.value = result;
  };
  const commitBottlenecks = (result: Awaited<ReturnType<typeof getOrchestrationMetricBottlenecks>>): void => {
    if (handleApiError(result, "多信号节点异常加载失败")) bottlenecks.value = result;
  };
  if (analysisCached.value) commitAnalysis(analysisCached.value);
  if (bottleneckCached.value) commitBottlenecks(bottleneckCached.value);
  if (analysisCached.state === "miss") analysis.value = null;
  if (bottleneckCached.state === "miss") bottlenecks.value = null;
  analysisLoading.value = analysisCached.state === "miss" || bottleneckCached.state === "miss";
  const requests: Promise<void>[] = [loadCorrelation(correlationVersion, requestVersion)];
  if (analysisCached.refresh) requests.push(analysisCached.refresh.then((result) => {
    if (isCurrent()) commitAnalysis(result);
  }));
  if (bottleneckCached.refresh) requests.push(bottleneckCached.refresh.then((result) => {
    if (isCurrent()) commitBottlenecks(result);
  }));
  try {
    await Promise.all(requests);
  } finally {
    if (isCurrent()) analysisLoading.value = false;
  }
}

/** Loads the selected correlation pair and rejects stale dashboard or selector responses. */
async function loadCorrelation(requestVersion = correlationRequestVersion, dashboardVersion = dashboardRequestVersion): Promise<void> {
  if (requestVersion !== correlationRequestVersion || dashboardVersion !== dashboardRequestVersion) return;
  const xMetric = correlationXMetric.value;
  const yMetric = correlationYMetric.value;
  const query = { ...buildQueryFilters(), xMetric, yMetric };
  const cached = resolveMetricQuery("correlations", { xMetric, yMetric },
    () => getOrchestrationMetricCorrelations(ctx.value, query));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricCorrelations>>): void => {
    if (!handleApiError(result, "质量关联加载失败")) return;
    if (result.xMetric !== xMetric || result.yMetric !== yMetric) {
      errorMessage.value = "质量关联响应指标与当前查询不一致";
      errorCode.value = "ORCH_METRICS_CORRELATION_MISMATCH";
      message.error(errorMessage.value);
      return;
    }
    correlations.value = result;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) correlationLoading.value = false;
  if (!cached.refresh) return;
  correlationLoading.value = !hasCached;
  if (!hasCached) correlations.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== correlationRequestVersion
      || dashboardVersion !== dashboardRequestVersion
      || xMetric !== correlationXMetric.value
      || yMetric !== correlationYMetric.value) return;
    commit(result);
  } finally {
    if (requestVersion === correlationRequestVersion) correlationLoading.value = false;
  }
}

/** Reloads only the selected breakdown dimension while preserving the applied cohort. */
async function loadAnalysisBreakdown(): Promise<void> {
  captureActiveQuerySnapshot();
  const requestVersion = ++analysisRequestVersion;
  const query = buildQueryFilters();
  const cached = resolveMetricQuery("analysis", { dimension: query.dimension },
    () => getOrchestrationMetricAnalysis(ctx.value, query));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricAnalysis>>): void => {
    if (handleApiError(result, "维度分析加载失败")) analysis.value = result;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) analysisLoading.value = false;
  if (!cached.refresh) return;
  analysisLoading.value = !hasCached;
  if (!hasCached) analysis.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== analysisRequestVersion) return;
    commit(result);
  } finally {
    if (requestVersion === analysisRequestVersion) analysisLoading.value = false;
  }
}

/** Loads the summary without allowing an older request to overwrite a refresh result. */
async function loadSummary(requestVersion = dashboardRequestVersion): Promise<void> {
  if (requestVersion !== dashboardRequestVersion) return;
  const commitVersion = summaryCommitVersion;
  const cached = resolveMetricQuery("summary", {}, () => getOrchestrationMetricSummary(ctx.value, buildQueryFilters()));
  const hasCached = cached.state !== "miss";
  const commit = (result: Awaited<ReturnType<typeof getOrchestrationMetricSummary>>): void => {
    if (handleApiError(result, "编排度量加载失败")) summary.value = result;
  };
  if (cached.value) commit(cached.value);
  if (hasCached) summaryLoading.value = false;
  if (!cached.refresh) return;
  summaryLoading.value = !hasCached;
  if (!hasCached) summary.value = null;
  try {
    const result = await cached.refresh;
    if (requestVersion !== dashboardRequestVersion || commitVersion !== summaryCommitVersion) return;
    commit(result);
  } finally {
    if (requestVersion === dashboardRequestVersion) summaryLoading.value = false;
  }
}

/** 刷新编排度量快照，mode=incremental 只拉变化数据，mode=full 全量重新采集。 */
async function refreshMetrics(mode: "incremental" | "full" = "incremental"): Promise<void> {
  if (!canQuery.value) return;
  captureActiveQuerySnapshot();
  const requestVersion = ++refreshRequestVersion;
  const contextKey = buildMetricCacheContextKey();
  const isCurrent = (): boolean => componentActive
    && requestVersion === refreshRequestVersion
    && contextKey === renderedMetricContextKey;
  closeNodeExecutions();
  closeContractDetails();
  dashboardRequestVersion += 1;
  flowRequestVersion += 1;
  correlationRequestVersion += 1;
  correlationLoading.value = false;
  summaryLoading.value = false;
  analysisLoading.value = false;
  flowLoading.value = false;
  conformanceRequestVersion += 1;
  conformanceLoading.value = false;
  costsRequestVersion += 1;
  costsPage.value = 1;
  costsLoading.value = false;
  costsError.value = "";
  experimentsRequestVersion += 1;
  experimentsError.value = "";
  experimentsLoading.value = false;
  evaluationSetsRequestVersion += 1;
  evaluationSetsLoading.value = false;
  deliveryRequestVersion += 1;
  deliveryError.value = "";
  deliveryLoading.value = false;
  deliveryPage.value = 1;
  codeAttributionRequestVersion += 1;
  codeAttributionError.value = "";
  codeAttributionLoading.value = false;
  codeAttributionPage.value = 1;
  summaryCommitVersion += 1;
  refreshing.value = true;
  errorMessage.value = "";
  errorCode.value = "";
  try {
    const result = await refreshOrchestrationMetrics(ctx.value, buildQueryFilters(), mode);
    if (!result.ok) {
      if (isCurrent()) handleApiError(result, "编排度量刷新失败");
      return;
    }
    clearOrchestrationMetricQueryCache();
    if (!isCurrent()) return;
    resetLazyMetricViewsForContextChange();
    summaryCommitVersion += 1;
    summary.value = result.summary;
    writeCurrentMetricCache("summary", {}, { ...result.summary, ok: true } as ApiResult<OrchestrationMetricSummary>);
    analysis.value = null;
    bottlenecks.value = null;
    correlations.value = null;
    flowPage.value = 1;
    conformancePage.value = 1;
    costsPage.value = 1;
    deliveryPage.value = 1;
    codeAttributionPage.value = 1;
    const requestVersion = ++dashboardRequestVersion;
    const flowVersion = ++flowRequestVersion;
    const conformanceVersion = ++conformanceRequestVersion;
    const costsVersion = ++costsRequestVersion;
    const experimentsVersion = ++experimentsRequestVersion;
    const evaluationSetsVersion = ++evaluationSetsRequestVersion;
    const deliveryVersion = ++deliveryRequestVersion;
    const codeAttributionVersion = ++codeAttributionRequestVersion;
    const requests = [loadDeepAnalysis(requestVersion), loadFlow(flowVersion)];
    if (activeTab.value === "conformance") requests.push(loadConformance(conformanceVersion));
    if (activeTab.value === 'costs' || activeTab.value === 'overview') requests.push(loadCosts(costsVersion));
    if (activeTab.value === "experiments" && experimentView.value === "comparison") requests.push(loadExperiments(experimentsVersion));
    if (activeTab.value === "experiments" && experimentView.value !== "comparison") requests.push(loadEvaluationSets(evaluationSetsVersion));
    if (activeTab.value === "delivery") requests.push(loadDelivery(deliveryVersion));
    if (activeTab.value === "code_attribution" || activeTab.value === 'overview') requests.push(loadCodeAttribution(codeAttributionVersion));
    await Promise.all(requests);
    if (!isCurrent()) return;
    void probeDeliveryEntry();
    const status = result.summary.freshness.status;
    if (status === "fresh") message.success(result.summary.freshness.message || "编排度量已刷新");
    if (status === "offline") message.info(result.summary.freshness.message || "当前范围没有在线 Client，已展示最近快照");
    if (status === "error" || status === "stale") message.warning(result.summary.freshness.message || "编排度量部分刷新失败");
  } finally {
    if (requestVersion === refreshRequestVersion) refreshing.value = false;
  }
}

/** Opens the bounded operations drawer and loads source diagnostics for the applied scope. */
async function openSourceHealth(): Promise<void> {
  if (!canQuery.value) return;
  sourceHealthDrawerOpen.value = true;
  await loadSourceHealth();
}

/** Loads source health without replacing a failed request with an empty result. */
async function loadSourceHealth(): Promise<void> {
  const requestVersion = ++sourceHealthRequestVersion;
  sourceHealthLoading.value = true;
  sourceHealthError.value = "";
  try {
    const result = await getOrchestrationMetricSources(ctx.value, buildQueryFilters());
    if (requestVersion !== sourceHealthRequestVersion) return;
    if (!result.ok) {
      sourceHealthError.value = result.message || "来源健康加载失败";
      message.error(sourceHealthError.value);
      return;
    }
    sourceHealth.value = result;
  } finally {
    if (requestVersion === sourceHealthRequestVersion) sourceHealthLoading.value = false;
  }
}

/** Invalidates in-flight source operations when the drawer closes. */
function closeSourceHealth(): void {
  sourceHealthRequestVersion += 1;
  sourceHealthDrawerOpen.value = false;
  sourceHealthLoading.value = false;
}

/** Retries one server-authorized failed source and reloads both operations and metric views. */
async function retryMetricSource(item: OrchestrationMetricSourceHealthItem): Promise<void> {
  if (!item.canRetry || retryingSourceKey.value) return;
  const requestVersion = ++sourceRetryRequestVersion;
  retryingSourceKey.value = item.sourceKey;
  sourceHealthError.value = "";
  try {
    const result = await retryOrchestrationMetricSource(ctx.value, item.sourceKey, buildQueryFilters());
    if (requestVersion !== sourceRetryRequestVersion || !componentActive) return;
    if (!result.ok) {
      sourceHealthError.value = result.message || "来源重采失败";
      message.error(sourceHealthError.value);
      await loadSourceHealth();
      return;
    }
    message.success("来源重采已完成");
    clearOrchestrationMetricQueryCache();
    resetLazyMetricViewsForContextChange();
    await Promise.all([loadSourceHealth(), loadDashboard()]);
  } finally {
    if (requestVersion === sourceRetryRequestVersion) retryingSourceKey.value = null;
  }
}

/** Switches to the existing delivery view for batch-level investigation. */
function openDeliveryBatches(): void {
  closeSourceHealth();
  activeTab.value = "delivery";
}

function handleScopeChange(): void {
  const scope = selectedScope.value;
  selectedScopeId.value = scope?.requiresSelection ? null : scope?.scopeId ?? null;
  candidateSearch.value = "";
  candidates.value = [];
  filters.page = 1;
  void loadDashboard();
}

function handleCandidateChange(): void {
  filters.page = 1;
  void loadDashboard();
}

/** 应用用户提交的筛选条件，并在主摘要成功返回后记录查询。 */
async function applyFilters(): Promise<void> {
  filters.page = 1;
  experimentsPage.value = 1;
  focusedCohortKey.value = null;
  await loadDashboard();
  if (!summary.value) return;
  trackProductEvent("orchestration_metrics_query", {
    scope_type: selectedScopeKind.value,
    tab: activeTab.value,
    has_date_range: filters.range !== "all",
  });
}

/** Creates one export and ignores responses from an older account session or export request. */
async function startExport(dataset: OrchestrationMetricExportDataset): Promise<void> {
  if ((dataset === "instances" || dataset === "nodes") && !detailsAllowed.value) {
    message.warning("当前群体范围受隐私保护，只能导出已抑制的汇总数据。");
    return;
  }
  const queryFilters = buildQueryFilters();
  if (dataset === "audit_bundle" && (queryFilters.from == null || queryFilters.to == null)) {
    message.warning("审计证据包需要明确时间范围，请选择最近 7 天、30 天或 90 天。");
    return;
  }
  if (dataset === "audit_bundle") {
    queryFilters.evaluationCriteria = [...experimentCriteria.value];
    queryFilters.experimentComparability = experimentComparability.value;
    queryFilters.contractTypes = contractTypeFilter.value === "all" ? [] : [contractTypeFilter.value];
    queryFilters.contractEvaluationStatuses = contractStatusFilter.value === "all" ? [] : [contractStatusFilter.value];
  }
  const requestVersion = ++exportRequestVersion;
  exportLoading.value = true;
  exportPollError.value = "";
  try {
    const result = await createOrchestrationMetricExport(ctx.value, queryFilters, dataset);
    if (requestVersion !== exportRequestVersion) return;
    if (!handleApiError(result, "创建导出任务失败")) return;
    exportJob.value = result;
    message.success("导出任务已创建");
    trackProductEvent("orchestration_metrics_export", {
      action: "start",
      dataset,
      format: result.format,
      scope_type: selectedScopeKind.value,
    });
    pollExport();
  } finally {
    if (requestVersion === exportRequestVersion) exportLoading.value = false;
  }
}

function handleExportMenuClick(info: { key: string | number }): void {
  void startExport(String(info.key) as OrchestrationMetricExportDataset);
}

/** Polls only the export that is still current for this account session. */
function pollExport(): void {
  if (!exportJob.value || ["succeeded", "failed", "cancelled", "expired"].includes(exportJob.value.status)) return;
  if (exportPollTimer) clearTimeout(exportPollTimer);
  const requestVersion = exportRequestVersion;
  const exportId = exportJob.value.id;
  exportPollError.value = "";
  exportPollTimer = setTimeout(async () => {
    const result = await getOrchestrationMetricExport(ctx.value, exportId);
    if (requestVersion !== exportRequestVersion || exportJob.value?.id !== exportId) return;
    if (!result.ok) {
      exportPollError.value = result.message || "导出状态查询失败";
      message.error(exportPollError.value);
      return;
    }
    exportJob.value = result;
    pollExport();
  }, 900);
}

/** Cancels only the export that remains current when the response returns. */
async function cancelExport(): Promise<void> {
  if (!exportJob.value) return;
  const requestVersion = exportRequestVersion;
  const exportId = exportJob.value.id;
  const result = await cancelOrchestrationMetricExport(ctx.value, exportId);
  if (requestVersion !== exportRequestVersion || exportJob.value?.id !== exportId) return;
  if (!handleApiError(result, "取消导出失败")) return;
  exportJob.value = result;
  message.info("已提交取消请求");
  trackProductEvent("orchestration_metrics_export", {
    action: "cancel",
    dataset: result.dataset,
    format: result.format,
    scope_type: selectedScopeKind.value,
  });
}

/** 下载已完成的导出文件，并记录用户实际触发的下载动作。 */
function downloadExport(): void {
  if (!exportJob.value?.downloadUrl) return;
  trackProductEvent("orchestration_metrics_export", {
    action: "download",
    dataset: exportJob.value.dataset,
    format: exportJob.value.format,
    scope_type: selectedScopeKind.value,
  });
  window.location.assign(exportJob.value.downloadUrl);
}

/** Changes only the flow table page without reloading summary and analysis views. */
function handleFlowPageChange(page: number, pageSize?: number): void {
  const sizeChanged = pageSize !== undefined && pageSize !== flowPageSize.value;
  flowPage.value = sizeChanged ? 1 : page;
  flowPageSize.value = pageSize ?? flowPageSize.value;
  const requestVersion = ++flowRequestVersion;
  void loadFlow(requestVersion);
}

/** Changes only the conformance evidence page. */
function handleConformancePageChange(page: number, pageSize?: number): void {
  const sizeChanged = pageSize !== undefined && pageSize !== conformancePageSize.value;
  conformancePage.value = sizeChanged ? 1 : page;
  conformancePageSize.value = pageSize ?? conformancePageSize.value;
  void loadConformance(++conformanceRequestVersion);
}

/** Changes only the Agent Trace evidence page. */
function handleCostsPageChange(page: number, pageSize?: number): void {
  const sizeChanged = pageSize !== undefined && pageSize !== costsPageSize.value;
  costsPage.value = sizeChanged ? 1 : page;
  costsPageSize.value = pageSize ?? costsPageSize.value;
  void loadCosts(++costsRequestVersion);
}

function conformanceResultLabel(item: OrchestrationMetricConformanceDetailItem): string {
  if (item.result === "conformant") return "符合";
  if (item.result === "legal_skip") return "合法跳过";
  if (item.result === "manual_override") return "人工覆盖";
  if (item.result === "not_evaluated") return "未评价";
  const labels: Record<string, string> = { missing_required: "缺失必需节点", repeat_execution: "重复执行", invalid_branch: "非法分支", unexpected_execution: "未选路径执行" };
  return labels[item.deviationType ?? ""] ?? "流程偏离";
}

/** Uses a warning state for manual overrides because they are excluded from strict conformance. */
function conformanceResultColor(item: OrchestrationMetricConformanceDetailItem): string {
  if (item.result === "deviation") return "error";
  if (item.result === "manual_override") return "warning";
  if (item.result === "not_evaluated") return "default";
  return "success";
}

/** Opens the existing runtime monitor at the node supporting one conformance conclusion. */
async function openConformanceEvidence(item: OrchestrationMetricConformanceDetailItem): Promise<void> {
  await openMetricEvidence(item.instance.instanceId, item.routeTarget, item.nodeId);
}

/** Freezes visible controls into one immutable query basis shared by all related requests. */
function captureActiveQuerySnapshot(): void {
  const range = resolveRange(filters.range);
  activeQueryRange = filters.range;
  activeQuerySnapshot = {
    scopeKind: selectedScopeKind.value,
    scopeId: selectedScopeKind.value === "mine"
      ? String(config.userSummary?.userId ?? "").trim() || null
      : selectedScopeId.value,
    from: range.from,
    to: range.to,
    workflowIds: [...filters.workflowIds],
    roleStages: [...filters.roleStages],
    models: [...filters.models],
    costDimension: filters.costDimension,
    codeAttributionDimension: filters.codeAttributionDimension,
    compareMode: filters.compareMode,
    dimension: filters.dimension,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  };
}

/** Builds the cache context from the applied query while ignoring rolling absolute-time milliseconds. */
function buildMetricCacheContextKey(): string {
  if (!activeQuerySnapshot) captureActiveQuerySnapshot();
  const snapshot = activeQuerySnapshot!;
  return createOrchestrationMetricCacheContextKey({
    userId: String(config.userSummary?.userId ?? ""),
    scopeKind: snapshot.scopeKind,
    scopeId: snapshot.scopeId ?? null,
    range: activeQueryRange,
    workflowIds: snapshot.workflowIds ?? [],
    roleStages: snapshot.roleStages ?? [],
    models: snapshot.models ?? [],
    compareMode: snapshot.compareMode,
    timezone: snapshot.timezone,
  });
}

/** Resolves one top-level metric read from the current session cache and deduplicates its refresh. */
function resolveMetricQuery<T extends ApiResult<object>>(
  endpoint: string,
  input: Record<string, unknown>,
  load: () => Promise<T>,
) {
  const contextKey = buildMetricCacheContextKey();
  const scopeKind = activeQuerySnapshot?.scopeKind ?? "mine";
  return resolveOrchestrationMetricCachedQuery({
    contextKey,
    requestKey: createOrchestrationMetricCacheRequestKey(endpoint, input),
    load,
    shouldCache: (result) => isOrchestrationMetricQueryResultCacheable(scopeKind, result),
  });
}

/** Writes one known-success response only for the current account's own scope. */
function writeCurrentMetricCache<T>(endpoint: string, input: Record<string, unknown>, value: T): void {
  if (activeQuerySnapshot?.scopeKind !== "mine") return;
  writeOrchestrationMetricQueryCache(
    buildMetricCacheContextKey(),
    createOrchestrationMetricCacheRequestKey(endpoint, input),
    value,
  );
}

/** Builds one page from the last applied query snapshot rather than live unsaved controls. */
function buildQueryFilters(page = filters.page, pageSize = filters.pageSize): OrchestrationMetricFilters {
  if (!activeQuerySnapshot) captureActiveQuerySnapshot();
  const snapshot = activeQuerySnapshot!;
  return {
    ...snapshot,
    workflowIds: [...(snapshot.workflowIds ?? [])],
    roleStages: [...(snapshot.roleStages ?? [])],
    models: [...(snapshot.models ?? [])],
    costDimension: snapshot.costDimension ?? "workflow",
    page,
    pageSize,
  };
}

/** Reuses dashboard filters while keeping flow pagination independent from detail pagination. */
function buildFlowQueryFilters(): OrchestrationMetricFilters {
  return buildQueryFilters(flowPage.value, flowPageSize.value);
}

/** Loads execution-level facts for one logical node into the evidence drawer. */
async function openNodeExecutions(nodeId: string, nodeLabel: string): Promise<void> {
  if (!detailsAllowed.value) return;
  nodeExecutionNodeId.value = nodeId;
  nodeExecutionRoleStageId.value = "";
  nodeExecutionLabel.value = nodeLabel || nodeId;
  nodeExecutionPage.value = 1;
  nodeExecutionTotal.value = 0;
  await loadNodeExecutionPage(1, nodeExecutionPageSize.value);
}

/** Opens execution evidence aggregated by one frozen role stage. */
async function openRoleStageExecutions(roleStageId: string, roleStageName: string): Promise<void> {
  if (!detailsAllowed.value) return;
  nodeExecutionNodeId.value = "";
  nodeExecutionRoleStageId.value = roleStageId;
  nodeExecutionLabel.value = roleStageName || roleStageId;
  nodeExecutionPage.value = 1;
  nodeExecutionTotal.value = 0;
  await loadNodeExecutionPage(1, nodeExecutionPageSize.value);
}

/** Loads one node execution page and ignores responses from closed or superseded drawers. */
async function loadNodeExecutionPage(page: number, pageSize: number): Promise<void> {
  const requestVersion = ++nodeExecutionRequestVersion;
  nodeExecutionDrawerOpen.value = true;
  nodeExecutionLoading.value = true;
  nodeExecutionRows.value = [];
  nodeExecutionWarning.value = "";
  try {
    const result = await getOrchestrationMetricNodeDetails(ctx.value, {
      ...buildQueryFilters(page, pageSize),
      nodeIds: nodeExecutionNodeId.value ? [nodeExecutionNodeId.value] : undefined,
      roleStages: nodeExecutionRoleStageId.value ? [nodeExecutionRoleStageId.value] : undefined,
    });
    if (requestVersion !== nodeExecutionRequestVersion) return;
    if (!handleApiError(result, "节点执行轮次加载失败")) return;
    nodeExecutionPage.value = result.page;
    nodeExecutionPageSize.value = result.pageSize;
    nodeExecutionTotal.value = result.total;
    nodeExecutionRows.value = [...result.items].sort((a, b) =>
      b.instance.updatedAt - a.instance.updatedAt || b.attemptNo - a.attemptNo,
    );
    nodeExecutionWarning.value = buildNodeExecutionWarning(result.metadata);
  } finally {
    if (requestVersion === nodeExecutionRequestVersion) nodeExecutionLoading.value = false;
  }
}

/** Applies drawer pagination without changing the dashboard detail page. */
function handleNodeExecutionPageChange(page: number, pageSize: number): void {
  const nextPage = pageSize === nodeExecutionPageSize.value ? page : 1;
  void loadNodeExecutionPage(nextPage, pageSize);
}

/** Invalidates an in-flight drawer request when the user closes it. */
function closeNodeExecutions(): void {
  nodeExecutionRequestVersion += 1;
  nodeExecutionDrawerOpen.value = false;
  nodeExecutionLoading.value = false;
  nodeExecutionRows.value = [];
  nodeExecutionTotal.value = 0;
  nodeExecutionWarning.value = "";
}

/** Converts collection-level evidence gaps into one drawer warning without treating normal paging as partial data. */
function buildNodeExecutionWarning(metadata: OrchestrationMetricAnalysisMetadata): string {
  const labels = metadata.partialReasons.flatMap((reason) => {
    if (reason === "collection_failed") return ["存在在线来源采集失败"];
    if (reason === "collection_truncated") return ["来源采集被截断"];
    if (reason === "offline_source") return ["存在离线来源"];
    if (reason === "invalid_payload") return ["存在损坏实例载荷"];
    if (reason === "missing_raw_trace") return ["存在缺失原始运行证据"];
    return [];
  });
  return labels.length > 0 ? `当前执行证据可能不完整：${[...new Set(labels)].join("；")}` : "";
}

/** Opens the contract evidence drawer at the first page with explicit filters reset. */
async function openContractDetails(): Promise<void> {
  if (!detailsAllowed.value) return;
  contractTypeFilter.value = "all";
  contractStatusFilter.value = "all";
  contractDetailPage.value = 1;
  contractDetailDrawerOpen.value = true;
  await loadContractDetailPage(1, contractDetailPageSize.value);
}

/** Loads one server-paged contract slice and discards closed or superseded responses. */
async function loadContractDetailPage(page: number, pageSize: number): Promise<void> {
  const requestVersion = ++contractDetailRequestVersion;
  contractDetailLoading.value = true;
  contractDetailError.value = "";
  contractDetailRows.value = [];
  try {
    const result = await getOrchestrationMetricContractDetails(ctx.value, {
      ...buildQueryFilters(page, pageSize),
      contractTypes: contractTypeFilter.value === "all" ? [] : [contractTypeFilter.value],
      contractEvaluationStatuses: contractStatusFilter.value === "all" ? [] : [contractStatusFilter.value],
    });
    if (requestVersion !== contractDetailRequestVersion || !contractDetailDrawerOpen.value) return;
    if (!result.ok) {
      contractDetailError.value = result.message || "契约明细加载失败";
      contractDetailTotal.value = 0;
      message.error(contractDetailError.value);
      return;
    }
    contractDetailPage.value = result.page;
    contractDetailPageSize.value = result.pageSize;
    contractDetailTotal.value = result.total;
    contractDetailRows.value = result.items;
  } finally {
    if (requestVersion === contractDetailRequestVersion) contractDetailLoading.value = false;
  }
}

/** Applies contract drawer pagination independently from dashboard pagination. */
function handleContractDetailPageChange(page: number, pageSize?: number): void {
  const nextPage = pageSize === undefined || pageSize === contractDetailPageSize.value ? page : 1;
  void loadContractDetailPage(nextPage, pageSize ?? contractDetailPageSize.value);
}

/** Reloads the first contract page after a type or evaluation-state filter changes. */
function handleContractDetailFilterChange(): void {
  void loadContractDetailPage(1, contractDetailPageSize.value);
}

/** Invalidates in-flight contract requests and clears drawer-local failure state. */
function closeContractDetails(): void {
  contractDetailRequestVersion += 1;
  contractDetailDrawerOpen.value = false;
  contractDetailLoading.value = false;
  contractDetailError.value = "";
  contractDetailRows.value = [];
  contractDetailTotal.value = 0;
}

/** Keeps execution identifiers compact while preserving a recognizable suffix. */
function formatExecutionId(value: string | null | undefined): string {
  const id = String(value ?? "").trim();
  if (!id) return "-";
  return id.length <= 18 ? id : `${id.slice(0, 8)}...${id.slice(-6)}`;
}

/** Builds a stable key for any public cost dimension. */
function costGroupRowKey(record: OrchestrationMetricCostsResponse["groups"][number]): string {
  return `${record.dimension}\u001f${record.dimensionKey}`;
}

/** Formats the credential route captured at invocation time. */
function credentialSourceLabel(value: string | null | undefined): string {
  if (value === "codeflow_key") return "CodeFlow 中转";
  if (value === "local_oauth") return "本机 OAuth";
  if (value === "local_api_key") return "本机 API Key";
  if (value === "none") return "无可用凭据";
  return "历史未记录";
}

function resolveRange(range: RangePreset): { from: number | null; to: number | null } {
  if (range === "all") return { from: null, to: null };
  const now = Date.now();
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return { from: now - days * 24 * 60 * 60_000, to: now };
}

function handleApiError<T extends object>(result: ApiResult<T>, fallback: string): result is { ok: true } & T {
  if (result.ok) return true;
  errorCode.value = result.code;
  errorMessage.value = result.message || fallback;
  if (result.code !== "ORCH_METRICS_SCOPE_REQUIRED") {
    message.error(errorMessage.value);
  }
  return false;
}

function formatRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 1000) / 10}%`;
}

/** Formats one DORA value while preserving explicit unavailable states. */
function formatDoraValue(metric: OrchestrationMetricDoraValue): string {
  if (metric.status !== "available" || metric.value === null) return "不可判定";
  if (metric.unit === "rate") return formatRate(metric.value);
  if (metric.unit === "milliseconds") return formatDuration(metric.value);
  if (metric.unit === "per_day") return `${metric.value.toFixed(2)} 次/天`;
  return Math.round(metric.value).toLocaleString();
}

/** Explains why one DORA value is unavailable without exposing internal reason codes. */
function doraAvailabilityText(metric: OrchestrationMetricDoraValue): string {
  if (metric.status === "available") return `样本 ${metric.sampleSize}`;
  const reasons: Record<string, string> = {
    reconciliation_incomplete: "交付批次未完整对账",
    no_successful_production_deployment: "没有成功生产部署",
    deployment_commit_link_incomplete: "部署缺少精确 Commit 关联",
    no_terminal_production_deployment: "没有终态生产部署",
    no_failed_production_deployment: "没有失败或需补救的部署",
    recovery_link_incomplete: "失败部署缺少恢复或回滚关联",
    deployment_rework_classification_incomplete: "部署返工标记不完整",
    eligible_sample_missing: "没有可计算样本",
  };
  return reasons[metric.reason ?? ""] ?? "必要事实不完整";
}

/** Translates delivery fact kinds without changing the persisted contract. */
function deliveryKindLabel(kind: OrchestrationMetricDeliveryFact["kind"]): string {
  if (kind === "commit") return "提交";
  if (kind === "pull_request") return "PR";
  if (kind === "test_run") return "测试";
  if (kind === "deployment") return "部署";
  if (kind === "rollback") return "回滚";
  return "恢复";
}

/** Translates delivery status for compact table display. */
function deliveryStatusLabel(status: OrchestrationMetricDeliveryFact["status"]): string {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  return "取消";
}

/** Formats one exact cohort confidence interval without implying certainty. */
function formatConfidenceInterval(summary: OrchestrationMetricExperimentsResponse["currentTotals"] | null): string {
  if (!summary || summary.confidenceLow == null || summary.confidenceHigh == null) return "-";
  return `${formatRate(summary.confidenceLow)} - ${formatRate(summary.confidenceHigh)}`;
}

/** Maps deterministic grader criteria to compact operator-facing labels. */
function evaluationCriterionLabel(criterion: string): string {
  if (criterion === "trace_evidence_integrity") return "运行证据完整性";
  if (criterion === "tool_path_efficiency") return "工具路径效率";
  return criterion;
}

/** Maps conservative cohort conclusions to display text. */
function experimentConclusionLabel(conclusion: OrchestrationMetricExperimentsResponse["cohorts"][number]["conclusion"]): string {
  if (conclusion === "improved") return "当前周期更高";
  if (conclusion === "regressed") return "当前周期更低";
  if (conclusion === "no_detectable_change") return "未检测到差异";
  return "不可比较";
}

/** Chooses a restrained status color for one cohort conclusion. */
function experimentConclusionColor(conclusion: OrchestrationMetricExperimentsResponse["cohorts"][number]["conclusion"]): string {
  if (conclusion === "improved") return "green";
  if (conclusion === "regressed") return "red";
  if (conclusion === "no_detectable_change") return "blue";
  return "default";
}

/** Translates server-owned comparability reasons without changing their thresholds. */
function experimentReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    current_cohort_missing: "当前周期无此配置",
    comparison_cohort_missing: "对比周期无此配置",
    current_sample_below_20: "当前有效样本少于 20",
    comparison_sample_below_20: "对比有效样本少于 20",
    current_evidence_incomplete: "当前证据覆盖不完整",
    comparison_evidence_incomplete: "对比证据覆盖不完整",
    privacy_suppressed: "受小群体保护",
  };
  return labels[reason] ?? "其他可比条件未满足";
}

/** Keeps immutable snapshot identities readable while retaining hover access to the full hash. */
function shortSnapshotHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/** 为从改进需求返回的 Cohort 行附加稳定定位和高亮属性。 */
function cohortRowAttributes(record: OrchestrationMetricEvaluationCohortItem): Record<string, string> {
  return {
    "data-cohort-key": record.cohortKey,
    class: record.cohortKey === focusedCohortKey.value ? "orchestration-metrics__cohort-row--focused" : "",
  };
}

/** Opens the improvement composer only after loading explicit writable workspace choices. */
async function openImprovementComposer(record: OrchestrationMetricEvaluationCohortItem): Promise<void> {
  if (record.privacy?.status === "suppressed" || record.comparisonPrivacy?.status === "suppressed") {
    message.warning("当前 Cohort 受小群体保护，不能写入改进需求。");
    return;
  }
  if (!workspaces.workspaces.length) {
    try {
      await workspaces.refresh(ctx.value);
    } catch (error) {
      message.error(error instanceof Error ? `可写工作区加载失败：${error.message}` : "可写工作区加载失败");
      return;
    }
  }
  improvementCohort.value = record;
  improvementCandidateCohorts.value = [];
  improvementCandidateCohortKey.value = null;
  improvementCandidatesError.value = "";
  improvementMode.value = "create";
  improvementHypothesis.value = "";
  improvementTargetVersion.value = "";
  improvementObservationDays.value = 30;
  improvementAcceptanceText.value = "";
  improvementIntakeId.value = null;
  improvementIntakes.value = [];
  improvementIntakesRequestVersion += 1;
  improvementIntakesLoading.value = false;
  improvementIntakesError.value = "";
  const currentWorkspaceId = String(config.workspaceId ?? "").trim();
  improvementWorkspaceId.value = improvementWorkspaceOptions.value.some((option) => option.value === currentWorkspaceId && !option.disabled)
    ? currentWorkspaceId
    : improvementWorkspaceOptions.value.find((option) => !option.disabled)?.value ?? null;
  improvementModalOpen.value = true;
  await loadImprovementCandidateCohorts(record);
}

/** Loads every candidate page from the same frozen scope and periods; partial page sets are rejected. */
async function loadImprovementCandidateCohorts(baseline: OrchestrationMetricEvaluationCohortItem): Promise<void> {
  const experiment = experiments.value;
  const requestVersion = ++improvementCandidatesRequestVersion;
  improvementCandidatesLoading.value = true;
  improvementCandidatesError.value = "";
  improvementCandidateCohorts.value = [];
  improvementCandidateCohortKey.value = null;
  try {
    if (!experiment) throw new Error("当前评估结果已失效，请重新加载后再创建改进需求");
    const baseQuery: OrchestrationMetricFilters = {
      ...buildQueryFilters(),
      pageSize: 50,
      evaluationCriteria: [baseline.criterion as OrchestrationMetricEvaluationCriterion],
      experimentComparability: "all",
      experimentCohortKey: null,
    };
    if (baseQuery.from == null || baseQuery.to == null) throw new Error("候选 Cohort 需要明确时间范围");
    const loadPage = async (page: number): Promise<OrchestrationMetricExperimentsResponse> => {
      const result = await getOrchestrationMetricExperiments(ctx.value, { ...baseQuery, page });
      if (!result.ok) throw new Error(result.message || `候选 Cohort 第 ${page} 页加载失败`);
      return result;
    };
    const first = await loadPage(1);
    if (requestVersion !== improvementCandidatesRequestVersion) return;
    const pageCount = Math.ceil(first.total / first.pageSize);
    const remaining = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => loadPage(index + 2)))
      : [];
    if (requestVersion !== improvementCandidatesRequestVersion) return;
    const responses = [first, ...remaining];
    const samePeriod = (left: { from: number; to: number }, right: { from: number; to: number }) => left.from === right.from && left.to === right.to;
    const scopeId = experiment.scope.scopeId ?? null;
    if (responses.some((response) => response.total !== first.total
      || response.scope.scopeKind !== experiment.scope.scopeKind
      || (response.scope.scopeId ?? null) !== scopeId
      || !samePeriod(response.currentPeriod, experiment.currentPeriod)
      || !samePeriod(response.comparisonPeriod, experiment.comparisonPeriod))) {
      throw new Error("候选 Cohort 的范围或周期在加载期间发生变化，请重试");
    }
    const allCohorts = responses.flatMap((response) => response.cohorts);
    if (allCohorts.length !== first.total || new Set(allCohorts.map((cohort) => cohort.cohortKey)).size !== allCohorts.length) {
      throw new Error("候选 Cohort 分页结果不完整，请重试");
    }
    if (!allCohorts.some((cohort) => cohort.cohortKey === baseline.cohortKey)) {
      throw new Error("基线 Cohort 已不在当前筛选结果中，请重新选择");
    }
    improvementCandidateCohorts.value = allCohorts.filter((cohort) => cohort.cohortKey !== baseline.cohortKey
      && cohort.criterion === baseline.criterion
      && cohort.evaluatorId === baseline.evaluatorId
      && cohort.evaluatorVersion === baseline.evaluatorVersion);
    if (!improvementCandidateCohorts.value.length) {
      improvementCandidatesError.value = "当前筛选下没有评估器和标准一致的其他候选 Cohort";
    }
  } catch (error) {
    if (requestVersion === improvementCandidatesRequestVersion) {
      improvementCandidatesError.value = error instanceof Error ? error.message : "候选 Cohort 加载失败";
    }
  } finally {
    if (requestVersion === improvementCandidatesRequestVersion) improvementCandidatesLoading.value = false;
  }
}

/** Invalidates candidate requests when the composer closes. */
function closeImprovementComposer(): void {
  improvementCandidatesRequestVersion += 1;
  improvementIntakesRequestVersion += 1;
  improvementModalOpen.value = false;
  improvementCandidatesLoading.value = false;
  improvementIntakesLoading.value = false;
  improvementCandidateCohorts.value = [];
  improvementCandidateCohortKey.value = null;
  improvementIntakes.value = [];
  improvementIntakeId.value = null;
}

/** 加载目标工作区可编辑需求，供改进证据关联使用。 */
async function loadImprovementIntakes(search = ""): Promise<void> {
  const requestVersion = ++improvementIntakesRequestVersion;
  const workspaceId = improvementWorkspaceId.value;
  improvementIntakes.value = [];
  improvementIntakeId.value = null;
  improvementIntakesError.value = "";
  if (improvementMode.value !== "link" || !workspaceId) return;
  improvementIntakesLoading.value = true;
  try {
    const result = await listOrchIntakes(ctx.value, workspaceId as WorkspaceId, { limit: 100, sourceKind: "requirement", search: search.trim() || null });
    if (requestVersion !== improvementIntakesRequestVersion) return;
    if (!result.ok) throw new Error(result.message || "需求列表加载失败");
    improvementIntakes.value = result.intakes.filter((item) => !item.readOnly);
  } catch (error) {
    if (requestVersion !== improvementIntakesRequestVersion) return;
    improvementIntakesError.value = error instanceof Error ? error.message : "需求列表加载失败";
    message.error(improvementIntakesError.value);
  } finally {
    if (requestVersion === improvementIntakesRequestVersion) improvementIntakesLoading.value = false;
  }
}

/** 将多行验收条件转换为可持久化的阻断验收项。 */
function buildImprovementAcceptanceCriteria(existing: TaskAcceptanceCriterion[] | null | undefined): TaskAcceptanceCriterion[] | null {
  const lines = improvementAcceptanceText.value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const merged = [...(existing ?? [])];
  const existingTexts = new Set(merged.map((item) => item.text));
  lines.forEach((text, index) => {
    if (!existingTexts.has(text)) merged.push({ id: `metric_improvement_${Date.now()}_${index + 1}`, text, blocking: true });
  });
  return merged.length ? merged : null;
}

/** Freezes one server-owned exact cohort without deriving a new identity or conclusion. */
function buildImprovementCohortSnapshot(cohort: OrchestrationMetricEvaluationCohortItem): TaskIntakeMetricCohortSnapshot {
  const snapshotSummary = (value: OrchestrationMetricEvaluationCohortItem["current"]) => {
    if (!value) return null;
    if (value.evaluatedCount === null) throw new Error("受隐私保护的 Cohort 不能写入改进需求");
    return { evaluatedCount: value.evaluatedCount, coverageRate: value.coverageRate, passRate: value.passRate };
  };
  return {
    cohortKey: cohort.cohortKey,
    criterion: cohort.criterion,
    evaluatorId: cohort.evaluatorId,
    evaluatorVersion: cohort.evaluatorVersion,
    workflowSnapshotHash: cohort.workflowSnapshotHash,
    roleSnapshotHash: cohort.roleSnapshotHash,
    nodeId: cohort.nodeId,
    promptDefinitionHash: cohort.promptDefinitionHash,
    engine: cohort.engine,
    model: cohort.model,
    effort: cohort.effort,
    current: snapshotSummary(cohort.current),
    comparison: snapshotSummary(cohort.comparison),
    conclusion: cohort.conclusion,
  };
}

/** Builds one directed baseline/candidate pair for both create and link workflows. */
function buildImprovementEvidenceRef(
  baseline: OrchestrationMetricEvaluationCohortItem,
  candidate: OrchestrationMetricEvaluationCohortItem,
  experiment: OrchestrationMetricExperimentsResponse,
): TaskIntakeMetricCohortPairEvidenceRef {
  const createdAt = Date.now();
  return {
    kind: "orchestration_evaluation_cohort_pair",
    scopeKind: experiment.scope.scopeKind,
    scopeId: experiment.scope.scopeId ?? null,
    currentPeriod: experiment.currentPeriod,
    comparisonPeriod: experiment.comparisonPeriod,
    baseline: buildImprovementCohortSnapshot(baseline),
    candidate: buildImprovementCohortSnapshot(candidate),
    metricSchemaVersion: experiment.metricSchemaVersion,
    metricDefinitionVersion: experiment.metricDefinitionVersion,
    comparabilityPolicy: experiment.comparabilityPolicy,
    hypothesis: improvementHypothesis.value.trim(),
    targetVersion: improvementTargetVersion.value.trim(),
    observationWindow: { from: createdAt, to: createdAt + improvementObservationDays.value * 86_400_000 },
    reviews: null,
    createdAt,
  };
}

/** Creates or links one Task Intake with readable and structured cohort evidence. */
async function createImprovementIntake(): Promise<void> {
  const baseline = improvementCohort.value;
  const candidate = improvementCandidateCohort.value;
  const experiment = experiments.value;
  const workspaceId = improvementWorkspaceId.value;
  if (!baseline || !candidate || !experiment || !workspaceId || !improvementHypothesis.value.trim()
    || !improvementTargetVersion.value.trim() || !improvementAcceptanceText.value.trim()) return;
  improvementCreating.value = true;
  try {
    const describePeriod = (cohort: OrchestrationMetricEvaluationCohortItem, period: "current" | "comparison") => cohort[period]
      ? `${cohort[period]!.evaluatedCount} 个有效样本，通过率 ${formatRate(cohort[period]!.passRate)}，证据覆盖 ${formatRate(cohort[period]!.coverageRate)}`
      : "无对应 cohort";
    const title = `[度量改进] ${evaluationCriterionLabel(baseline.criterion)} · ${baseline.nodeId}`;
    const evidenceRef = buildImprovementEvidenceRef(baseline, candidate, experiment);
    const selectedIntake = improvementMode.value === "link"
      ? improvementIntakes.value.find((item) => String(item.id) === improvementIntakeId.value) ?? null
      : null;
    if (improvementMode.value === "link" && !selectedIntake) throw new Error("请选择要关联的已有需求");
    const metricEvidenceRefs = [
      ...(selectedIntake?.metricEvidenceRefs ?? []).filter((item) => item.kind !== "orchestration_evaluation_cohort_pair"
        || item.baseline.cohortKey !== baseline.cohortKey || item.candidate.cohortKey !== candidate.cohortKey),
      evidenceRef,
    ];
    if (metricEvidenceRefs.length > 20) throw new Error("该需求已关联过多度量证据，请新建改进需求或先清理历史关联");
    const savedResult = selectedIntake
      ? await upsertOrchIntake(ctx.value, { workspaceId: workspaceId as WorkspaceId, intake: {
        id: selectedIntake.id, triggerMode: selectedIntake.triggerMode, taskType: selectedIntake.taskType,
        title: selectedIntake.title, goal: selectedIntake.goal, background: selectedIntake.background ?? null,
        acceptanceCriteria: buildImprovementAcceptanceCriteria(selectedIntake.acceptanceCriteria),
        workbenchItemRefs: selectedIntake.workbenchItemRefs ?? null, seedArtifactRefs: selectedIntake.seedArtifactRefs ?? null,
        metricEvidenceRefs, constraints: selectedIntake.constraints ?? null, executionPlan: selectedIntake.executionPlan ?? null,
        requester: selectedIntake.requester ?? { source: "ui" },
      } })
      : await createOrchIntake(ctx.value, { workspaceId: workspaceId as WorkspaceId, intake: {
      triggerMode: "manual",
      taskType: "analysis",
      title,
       goal: `${improvementHypothesis.value.trim()}；目标配置：${improvementTargetVersion.value.trim()}。`,
       background: [
         "来源：编排度量 / 评估实验",
         `评估器：${baseline.evaluatorId}/${baseline.evaluatorVersion}；criterion=${baseline.criterion}`,
         `周期：${formatDateTime(experiment.comparisonPeriod.from)} 至 ${formatDateTime(experiment.comparisonPeriod.to)}；${formatDateTime(experiment.currentPeriod.from)} 至 ${formatDateTime(experiment.currentPeriod.to)}`,
         `基线创建时结果：当前 ${describePeriod(baseline, "current")}；对比 ${describePeriod(baseline, "comparison")}；${experimentConclusionLabel(baseline.conclusion)}`,
         `候选创建时结果：当前 ${describePeriod(candidate, "current")}；对比 ${describePeriod(candidate, "comparison")}；${experimentConclusionLabel(candidate.conclusion)}`,
         `基线配置：workflow=${baseline.workflowSnapshotHash}；node=${baseline.nodeId}；role=${baseline.roleSnapshotHash}；promptDefinition=${baseline.promptDefinitionHash}；engine/model/effort=${baseline.engine}/${baseline.model || "未记录"}/${baseline.effort || "未记录"}`,
         `候选配置：workflow=${candidate.workflowSnapshotHash}；node=${candidate.nodeId}；role=${candidate.roleSnapshotHash}；promptDefinition=${candidate.promptDefinitionHash}；engine/model/effort=${candidate.engine}/${candidate.model || "未记录"}/${candidate.effort || "未记录"}`,
       ].join("\n"),
      acceptanceCriteria: buildImprovementAcceptanceCriteria(null),
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      metricEvidenceRefs,
      constraints: { requireUserConfirmation: false, nodeApprovalMode: "manual" },
      executionPlan: null,
      requester: { source: "ui" },
    } });
    if (!savedResult.ok) throw new Error(savedResult.message || "改进需求保存失败");
    const intake = savedResult.intake;
    closeImprovementComposer();
    message.success(`${selectedIntake ? "改进证据已关联" : "改进需求已创建"}：${intake.title}`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建改进需求失败");
  } finally {
    improvementCreating.value = false;
  }
}

/** 格式化新旧指标口径的百分点差异。 */
function formatRateDelta(value: number): string {
  const points = Math.round(value * 1000) / 10;
  return `${points > 0 ? "+" : ""}${points} 个百分点`;
}

/** Formats verified success only when the response proves complete validation coverage. */
function formatVerifiedRate(value: number | null | undefined, coverageRate?: number | null): string {
  return value == null || !Number.isFinite(value) || coverageRate !== 1 ? "不可判定" : formatRate(value);
}

/** Formats the observed sample rate without turning it into a strict population conclusion. */
function formatObservedRate(metric: OrchestrationMetricRateEnvelope | null | undefined): string {
  return metric?.status === "unavailable" || metric?.observedRate == null
    ? "不可判定"
    : formatRate(metric.observedRate);
}

/** Explains validation coverage and the possible final rate in business language. */
function formatValidationRateDetail(
  metric: OrchestrationMetricRateEnvelope | null | undefined,
  rateLabel: string,
): string {
  if (!metric) return "当前服务尚未提供验证比例口径";
  if (metric.status === "unavailable" || metric.observedRate == null) {
    return metric.observedDenominator > 0
      ? "数据范围不完整，暂不能计算"
      : "当前范围没有已有验证结论的可评价实例";
  }
  if (metric.lowerBound == null || metric.upperBound == null) return "当前数据不足，暂不能推算最终结果";
  const rate = formatRate(metric.lowerBound);
  if (metric.status === "complete") {
    return metric.populationStatus === "recorded_facts"
      ? `${metric.eligibleDenominator} 个已记录可评价实例均已有验证结论 · ${rateLabel}为 ${rate}`
      : `${metric.eligibleDenominator} 个可评价实例均已有验证结论 · 最终${rateLabel}为 ${rate}`;
  }
  const rateRange = `${formatRate(metric.lowerBound)}～${formatRate(metric.upperBound)}`;
  return metric.populationStatus === "recorded_facts"
    ? `${metric.eligibleDenominator} 个已记录可评价实例中，${metric.observedDenominator} 个已有验证结论 · 其余已记录实例完成验证后，${rateLabel}可能为 ${rateRange}`
    : `${metric.eligibleDenominator} 个可评价实例中，${metric.observedDenominator} 个已有验证结论 · 其余实例完成验证后，最终${rateLabel}可能为 ${rateRange}`;
}

/** Explains complete samples or partial-coverage bounds in one compact line. */
function formatObservedRateDetail(
  metric: OrchestrationMetricRateEnvelope | null | undefined,
  coverageRate: number | null | undefined,
  resultLabel: string,
  recordedPopulationLabel = "终态",
): string {
  if (!metric) return "当前服务尚未提供样本比例口径";
  if (metric.status === "unavailable" || metric.observedRate == null) {
    return metric.observedDenominator > 0
      ? "计算范围不完整，暂不展示样本比例"
      : "当前范围没有可计算的已覆盖样本";
  }
  if (metric.lowerBound == null || metric.upperBound == null) return "当前范围没有可计算的总体边界";
  const boundaryLabel = metric.populationStatus === "recorded_facts" ? `已记录${recordedPopulationLabel}边界` : "全量边界";
  if (metric.status === "complete") {
    return `${metric.numerator}/${metric.observedDenominator} 个${resultLabel} · 覆盖 ${metric.observedDenominator}/${metric.eligibleDenominator}（${formatRate(coverageRate)}） · ${boundaryLabel} ${formatRate(metric.lowerBound)}`;
  }
  return `覆盖 ${metric.observedDenominator}/${metric.eligibleDenominator}（${formatRate(coverageRate)}） · ${boundaryLabel} ${formatRate(metric.lowerBound)}～${formatRate(metric.upperBound)}`;
}

function formatDuration(value: number | null | undefined): string {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Normalizes one Trace's uncached input count using the engine's cache-token semantics. */
function resolveTraceUncachedInputTokens(trace: OrchestrationMetricCostsResponse["items"][number]): number | null {
  const inputTokens = Number(trace.inputTokens);
  const cachedInputTokens = Number(trace.cachedInputTokens);
  const cacheCreationInputTokens = Number(trace.cacheCreationInputTokens);
  if (![inputTokens, cachedInputTokens, cacheCreationInputTokens].every(Number.isSafeInteger)) return null;
  const value = String(trace.engine).trim().toLowerCase() === "codex"
    ? inputTokens - cachedInputTokens + cacheCreationInputTokens
    : inputTokens + cacheCreationInputTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Formats one Trace's normalized uncached input count without treating missing facts as zero. */
function formatTraceUncachedInputTokens(trace: OrchestrationMetricCostsResponse["items"][number]): string {
  return resolveTraceUncachedInputTokens(trace)?.toLocaleString() ?? "不可用";
}

/** Formats one opaque source identity without exposing account identifiers. */
function shortSourceKey(value: string): string {
  return value ? value.slice(0, 12) : "-";
}

/** Translates the persisted source collection result. */
function sourceHealthStatusLabel(value: OrchestrationMetricSourceHealthItem["lastStatus"]): string {
  if (value === "succeeded") return "成功";
  if (value === "truncated") return "截断";
  if (value === "error") return "失败";
  if (value === "offline") return "离线";
  return "未采集";
}

/** Selects the existing tag palette for source-health states. */
function sourceHealthStatusColor(value: OrchestrationMetricSourceHealthItem["lastStatus"]): string {
  if (value === "succeeded") return "green";
  if (value === "truncated") return "orange";
  if (value === "error" || value === "offline") return "red";
  return "default";
}

/** Translates the last source collection mode. */
function sourceCollectionModeLabel(value: OrchestrationMetricSourceHealthItem["lastMode"]): string {
  if (value === "full") return "全量";
  if (value === "incremental") return "增量";
  return "-";
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN");
}

/** Formats one persisted evidence body for the bounded diagnostic code view. */
function formatEvidenceJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Builds a compact canonical event label for the collapse header. */
function conversationEvidenceLabel(event: ConversationEventEnvelope): string {
  return `C#${event.seq} ${event.type} · ${formatDateTime(event.ts)}`;
}

/** Builds a compact raw provider event label for the collapse header. */
function rawEvidenceLabel(event: RawEngineEventEnvelope): string {
  return `R#${event.seq} ${event.source} · ${event.action} · ${formatDateTime(event.ts)}`;
}

function formatBucketLabel(value: number): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone: summary.value?.filters.timezone || undefined,
  });
}

/** Builds one monotone line path while preserving the exact time-bucket order. */
function buildTrendLinePath(points: TrendChartPoint[], field: "yTotal" | "ySuccess"): string {
  return d3Line<TrendChartPoint>()
    .defined((point) => field === "yTotal" || point.bucket.privacy?.status !== "suppressed")
    .x((point) => point.x)
    .y((point) => point[field])
    .curve(curveMonotoneX)(points) ?? "";
}

/** Builds an accessible trend-point description without hiding incomplete validation coverage. */
function trendBucketAriaLabel(bucket: OrchestrationMetricSummary["trend"][number]): string {
  const bucketStart = new Date(bucket.bucketStart).toLocaleString("zh-CN", { timeZone: summary.value?.filters.timezone || undefined });
  const coverageRate = bucket.eligibleTasks !== null && bucket.eligibleTasks > 0 && bucket.validationCoveredTasks !== null
    ? bucket.validationCoveredTasks / bucket.eligibleTasks
    : null;
  return `${bucketStart}：总任务 ${bucket.totalTasks}，可评价 ${bucket.eligibleTasks ?? "受保护"}，已验证成功 ${bucket.successfulTasks ?? "受保护"}，成功率 ${formatVerifiedRate(bucket.successRate, coverageRate)}`;
}

/** Keeps at least one trend series visible when an operator toggles the legend. */
function handleTrendSeriesToggle(series: "total" | "success"): void {
  if (!showTrendTotal.value && !showTrendSuccess.value) {
    if (series === "total") showTrendSuccess.value = true;
    else showTrendTotal.value = true;
  }
}

/** 监听趋势画布宽度，并用实际可用区域更新横向坐标。 */
function bindTrendResizeObserver(): void {
  trendResizeObserver?.disconnect();
  trendResizeObserver = null;
  const element = trendCanvasElement.value;
  if (!element) return;
  const updateWidth = (width: number): void => {
    trendChartWidth.value = Math.max(TREND_CHART.minWidth, Math.round(width));
  };
  updateWidth(element.getBoundingClientRect().width);
  trendResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (width != null) updateWidth(width);
  });
  trendResizeObserver.observe(element);
}

/** 将趋势时间粒度转换为用户可读中文。 */
function trendBucketUnitLabel(unit: string | null | undefined): string {
  if (unit === "hour") return "按小时";
  if (unit === "day") return "按日";
  if (unit === "week") return "按周";
  if (unit === "month") return "按月";
  return "按时间段";
}

/** 将 IANA 时区标识转换为简洁中文说明。 */
function trendTimezoneLabel(timezone: string | null | undefined): string {
  if (!timezone) return "本地时区";
  if (timezone === "Asia/Shanghai") return "上海时区";
  if (timezone === "UTC") return "协调世界时";
  const offset = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value
    .replace("GMT", "UTC");
  return offset ? `时区：${offset}` : "当前时区";
}

/** 将指标粒度枚举转换为中文说明。 */
function metricGrainLabel(grain: OrchestrationMetricDefinition["grain"]): string {
  const labels: Record<OrchestrationMetricDefinition["grain"], string> = {
    scope: "统计范围",
    instance: "编排实例",
    node: "执行节点",
    trace: "Agent 调用轨迹",
    context_compaction: "上下文压缩",
    agent_handoff: "Agent 交接",
    quality_event: "质量事件",
    state_segment: "状态区间",
    contract: "规格契约",
    delivery: "交付事件",
    code_attribution: "代码贡献",
  };
  return labels[grain];
}

/** 将必要事实类型转换为中文说明，未知类型保留原标识便于排查。 */
function metricFactLabel(fact: string): string {
  const labels: Record<string, string> = {
    instance: "编排实例",
    validation: "验证结果",
    quality_event: "质量事件",
    contract_fact: "规格契约事实",
    state_segment: "状态区间",
    collection_coverage: "采集覆盖状态",
    fact_validation: "事实校验结果",
    delivery: "交付事实",
    reconciliation: "外部对账结果",
    commit: "代码提交",
    deployment: "部署事件",
    rollback: "回滚事件",
    recovery: "恢复事件",
  };
  return labels[fact] ?? fact;
}

/** Returns the scoped visual class for one flow breakdown category. */
function flowSegmentClass(segmentType: string): string {
  return `orchestration-metrics__flow-segment--${segmentType.replaceAll("_", "-")}`;
}

/** Identifies generated metric fixtures that intentionally have no local runtime instance. */
function isSyntheticMetricInstanceId(instanceId: string): boolean {
  return instanceId.startsWith("metric-fixture-");
}

/** Identifies generated flow fixtures that intentionally have no local runtime evidence. */
function isSyntheticFlowItem(item: OrchestrationMetricFlowInstanceItem): boolean {
  return isSyntheticMetricInstanceId(item.instanceId);
}

/** Describes why one flow row can or cannot open local runtime evidence. */
function flowEvidenceTooltip(item: OrchestrationMetricFlowInstanceItem): string {
  return isSyntheticFlowItem(item) ? "度量测试样本不对应本地运行实例" : "查看本地编排运行证据";
}

/** Describes the runtime-evidence boundary for one Agent cost Trace. */
function costTraceEvidenceTooltip(record: OrchestrationMetricCostsResponse["items"][number]): string {
  return isSyntheticMetricInstanceId(record.sourceInstanceId)
    ? "度量测试样本不对应本地运行实例"
    : "查看该调用的本地运行证据";
}

/** Waits until workspace intake hydration can no longer overwrite the evidence selection. */
async function waitForOrchestrationIntakesReady(timeoutMs = 10_000): Promise<void> {
  await nextTick();
  const deadline = Date.now() + timeoutMs;
  while (orch.intakesLoading) {
    if (Date.now() >= deadline) throw new Error("编排工作区需求列表加载超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Validates the live instance before switching workspace and opening its execution monitor. */
async function openFlowEvidence(item: OrchestrationMetricFlowInstanceItem): Promise<void> {
  if (isSyntheticFlowItem(item)) return;
  await openMetricEvidence(item.instanceId, item.routeTarget, null);
}

/** Resolves and validates the live workspace, intake, and instance behind one metric fact. */
async function requireMetricRuntimeTarget(
  instanceId: string,
  routeTarget: OrchestrationMetricRouteTarget | null | undefined,
): Promise<{ workspaceId: string; intakeId: string; instanceId: string }> {
  if (!routeTarget) throw new Error("该度量事实缺少运行证据定位信息");
  let resolution = resolveOrchestrationMetricEvidenceTarget(routeTarget, [
    String(config.workspaceId ?? ""),
    ...workspaces.workspaces.map((workspace) => String(workspace.id)),
  ]);
  if (resolution.status === "workspace_unavailable") {
    await workspaces.refresh(ctx.value);
    resolution = resolveOrchestrationMetricEvidenceTarget(
      routeTarget,
      workspaces.workspaces.map((workspace) => String(workspace.id)),
    );
  }
  if (resolution.status === "incomplete") {
    throw new Error("该度量实例缺少工作区、需求或运行实例标识");
  }
  if (resolution.status === "workspace_unavailable") {
    throw new Error("该度量实例所属工作区当前不可访问或标识不唯一");
  }
  const instanceResult = await getOrchInstance(ctx.value, {
    workspaceId: resolution.workspaceId as WorkspaceId,
    instanceId: resolution.instanceId as OrchestrationId,
  });
  if (!instanceResult.ok) {
    throw new Error(`${instanceResult.code}: ${instanceResult.message || `运行实例不存在或已被清理：${instanceId}`}`);
  }
  const runtimeIntakeId = String(instanceResult.instance.intakeSnapshot?.id ?? "").trim();
  if (!runtimeIntakeId || runtimeIntakeId !== resolution.intakeId) {
    throw new Error("度量目标与本地实例所属需求不一致");
  }
  return resolution;
}

/** Opens the evidence directory for one metric fact after validating its live instance identity. */
async function openMetricEvidence(
  instanceId: string,
  routeTarget: OrchestrationMetricRouteTarget | null | undefined,
  nodeId: string | null,
  attemptNo: number | null = null,
  promptSnapshotId: string | null = null,
): Promise<void> {
  if (isSyntheticMetricInstanceId(instanceId)) {
    message.warning("度量测试样本不对应本地运行实例，无法查看运行证据。");
    return;
  }
  if (openingEvidenceInstanceId.value) return;
  if (!routeTarget) {
    message.error("该度量事实缺少运行证据定位信息。");
    return;
  }
  const requestVersion = ++metricEvidenceRequestVersion;
  const requestId = createBrowserUuid();
  openingEvidenceInstanceId.value = instanceId;
  try {
    const resolution = await requireMetricRuntimeTarget(instanceId, routeTarget);
    if (!componentActive || requestVersion !== metricEvidenceRequestVersion) return;

    evidenceDrawerOpen.value = true;
    evidenceLoading.value = true;
    evidenceError.value = "";
    evidenceData.value = null;
    evidenceTarget.value = { ...resolution, nodeId };
    const evidenceResult = await getOrchRuntimeEvidence(ctx.value, {
      workspaceId: resolution.workspaceId as WorkspaceId,
      instanceId: resolution.instanceId as OrchestrationId,
      nodeId,
      attemptNo,
      promptSnapshotId,
      limit: promptSnapshotId ? 100 : 20,
    });
    if (!componentActive || requestVersion !== metricEvidenceRequestVersion) return;
    if (!evidenceResult.ok) {
      const sourceOffline = isWorkspaceClientOfflineError(`${evidenceResult.code}: ${evidenceResult.message}`);
      evidenceError.value = sourceOffline
        ? "证据源 Client 当前离线，连接后再重试。"
        : "当前无法读取运行证据，请稍后重试。";
      console.error("[OrchestrationMetricsPanel] runtime evidence load failed", {
        errorCode: String(evidenceResult.code || "ORCH_METRICS_EVIDENCE_LOAD_FAILED"),
        requestId,
        workspaceId: resolution.workspaceId,
        instanceId,
        nodeId,
        attemptNo,
        promptSnapshotId,
        cause: evidenceResult.message,
      });
      return;
    }
    evidenceData.value = evidenceResult;
  } catch (error) {
    if (!componentActive || requestVersion !== metricEvidenceRequestVersion) return;
    console.error("[OrchestrationMetricsPanel] runtime evidence request failed", {
      errorCode: "ORCH_METRICS_EVIDENCE_REQUEST_FAILED",
      requestId,
      workspaceId: routeTarget.workspaceId,
      instanceId,
      nodeId,
      attemptNo,
      promptSnapshotId,
      cause: error instanceof Error ? error.message : String(error),
    });
    if (isWorkspaceClientOfflineError(error)) {
      message.error("证据源 Client 离线，连接后再查看该运行实例。");
      return;
    }
    message.error("打开运行证据失败，请稍后重试。");
  } finally {
    if (requestVersion === metricEvidenceRequestVersion) {
      evidenceLoading.value = false;
      openingEvidenceInstanceId.value = null;
    }
  }
}

/** Opens the exact Prompt and Turn represented by one Agent cost Trace. */
async function openCostTraceEvidence(record: OrchestrationMetricCostsResponse["items"][number]): Promise<void> {
  await openMetricEvidence(
    record.sourceInstanceId,
    record.routeTarget,
    record.nodeId,
    record.attemptNo,
    record.promptSnapshotId,
  );
}

/** Enters the existing runtime monitor from the validated evidence target. */
async function openEvidenceRuntimeMonitor(): Promise<void> {
  const target = evidenceTarget.value;
  if (!target || evidenceMonitorLoading.value) return;
  const requestVersion = ++metricEvidenceRequestVersion;
  const sessionIdentity = `${config.serverWsOrigin}\u001f${config.userSummary?.userId ?? ""}\u001f${config.sessionToken ?? ""}`;
  /** Keeps intentional route navigation valid while rejecting account or session changes. */
  const isCurrentSession = () => sessionIdentity === `${config.serverWsOrigin}\u001f${config.userSummary?.userId ?? ""}\u001f${config.sessionToken ?? ""}`;
  evidenceMonitorLoading.value = true;
  try {
    const instanceResult = await getOrchInstance(ctx.value, {
      workspaceId: target.workspaceId as WorkspaceId,
      instanceId: target.instanceId as OrchestrationId,
    });
    if (requestVersion !== metricEvidenceRequestVersion || !isCurrentSession()) return;
    if (!instanceResult.ok) {
      if (isWorkspaceClientOfflineError(`${instanceResult.code}: ${instanceResult.message}`)) {
        message.error("证据源 Client 离线，连接后再查看该运行实例。");
        return;
      }
      message.error(instanceResult.message || "运行实例不存在或已被清理，无法打开证据。");
      return;
    }
    const runtimeIntakeId = String(instanceResult.instance.intakeSnapshot?.id ?? "").trim();
    if (!runtimeIntakeId || runtimeIntakeId !== target.intakeId) {
      message.error("度量目标与本地实例所属需求不一致，已停止下钻。");
      return;
    }
    config.switchWorkspace(target.workspaceId, { preservePrimaryThreadUrl: true });
    await router.push("/orchestration/workspace");
    if (!isCurrentSession()) return;
    await waitForOrchestrationIntakesReady();
    if (!isCurrentSession()) return;
    requirementAnalysis.openIntakeMode();
    orch.selectedIntakeId = target.intakeId as IntakeId;
    orch.selectedIntakeSnapshot = instanceResult.instance.intakeSnapshot;
    orch.selectedInstanceId = target.instanceId as OrchestrationId;
    orch.dispatchUiIntent({
      kind: "open_monitor",
      intakeId: target.intakeId as IntakeId,
      instanceId: target.instanceId as OrchestrationId,
      nodeId: target.nodeId,
    });
    evidenceDrawerOpen.value = false;
  } catch (error) {
    if (!isCurrentSession()) return;
    if (isWorkspaceClientOfflineError(error)) {
      message.error("证据源 Client 离线，连接后再查看该运行实例。");
      return;
    }
    message.error(`打开运行监控失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (requestVersion === metricEvidenceRequestVersion) evidenceMonitorLoading.value = false;
  }
}

/** Maps evidence availability to concise user-facing text. */
function evidenceStatusLabel(status: string): string {
  if (status === "available") return "可用";
  if (status === "incomplete") return "证据缺口";
  return "缺失";
}

/** Maps evidence availability to the corresponding status color. */
function evidenceStatusColor(status: string): string {
  if (status === "available") return "success";
  if (status === "incomplete") return "warning";
  return "default";
}

/** Formats the reasons a thread belongs to the current evidence scope. */
function evidenceThreadSources(sources: string[]): string {
  const labels: Record<string, string> = { master: "主线程", node: "节点线程", prompt_snapshot: "Prompt 关联" };
  return sources.map((source) => labels[source] ?? source).join(" / ");
}

/** Opens the exact node monitor represented by an execution fact. */
async function openNodeExecutionEvidence(item: OrchestrationMetricNodeDetailItem): Promise<void> {
  await openMetricEvidence(item.instance.instanceId, item.routeTarget, item.nodeId, item.attemptNo);
}

/** Opens the runtime scope or exact Prompt Snapshot represented by one contract fact. */
async function openContractEvidence(item: OrchestrationMetricContractDetailItem): Promise<void> {
  const promptSnapshotId = item.contractType === "runtime_evidence"
    && item.evidenceRef?.startsWith("prompt-snapshot:")
    ? item.evidenceRef.slice("prompt-snapshot:".length).trim() || null
    : null;
  await openMetricEvidence(item.instance.instanceId, item.routeTarget, item.nodeId ?? null, null, promptSnapshotId);
}

/** Returns whether one contract row has a trustworthy Artifact evidence reference. */
function canOpenArtifactDetails(item: OrchestrationMetricContractDetailItem): boolean {
  return !item.instance.instanceId.startsWith("metric-fixture-") && Boolean(resolveOrchestrationMetricArtifactId(item));
}

/** Loads one live Artifact, its files, and output fields after validating metric ownership. */
async function openArtifactDetails(item: OrchestrationMetricContractDetailItem): Promise<void> {
  const artifactId = resolveOrchestrationMetricArtifactId(item);
  if (!artifactId) {
    message.error("Artifact 度量事实缺少一致的证据引用。");
    return;
  }
  if (openingArtifactId.value) return;
  const requestVersion = ++artifactDetailRequestVersion;
  openingArtifactId.value = artifactId;
  artifactDetailDrawerOpen.value = true;
  artifactDetailLoading.value = true;
  artifactDetailError.value = "";
  artifactFilesError.value = "";
  artifactDetail.value = null;
  artifactDetailFiles.value = [];
  artifactDetailFields.value = [];
  artifactDetailRecord.value = item;
  artifactDetailWorkspaceId.value = null;
  artifactPreviewPath.value = "";
  try {
    const target = await requireMetricRuntimeTarget(item.instance.instanceId, item.routeTarget);
    if (requestVersion !== artifactDetailRequestVersion || !artifactDetailDrawerOpen.value) return;
    const workspaceId = target.workspaceId as WorkspaceId;
    const artifactResult = await getOrchArtifact(ctx.value, {
      workspaceId,
      artifactId: artifactId as Artifact["id"],
    });
    if (!artifactResult.ok) {
      throw new Error(`${artifactResult.code}: ${artifactResult.message || "Artifact 读取失败"}`);
    }
    const identity = resolveOrchestrationMetricArtifactTarget({
      artifactId,
      instanceId: item.instance.instanceId,
      nodeId: item.nodeId,
    }, artifactResult.artifact);
    if (identity.status === "invalid") throw new Error(identity.reason);
    if (requestVersion !== artifactDetailRequestVersion || !artifactDetailDrawerOpen.value) return;
    artifactDetail.value = artifactResult.artifact;
    artifactDetailWorkspaceId.value = workspaceId;

    const filesResult = await listOrchArtifactFiles(ctx.value, { workspaceId, artifactId });
    if (requestVersion !== artifactDetailRequestVersion || !artifactDetailDrawerOpen.value) return;
    if (!filesResult.ok) {
      artifactFilesError.value = filesResult.message || "Artifact 文件与字段索引读取失败";
      return;
    }
    artifactDetailFiles.value = filesResult.files;
    artifactDetailFields.value = filesResult.fields ?? [];
    const presentation = buildArtifactPresentation(artifactResult.artifact, filesResult.files);
    artifactPreviewPath.value = presentation.files[0]?.filePath ?? presentation.filePath;
  } catch (error) {
    if (requestVersion !== artifactDetailRequestVersion || !artifactDetailDrawerOpen.value) return;
    if (isWorkspaceClientOfflineError(error)) {
      notifyWorkspaceClientOffline("Artifact 证据源 Client 离线，连接后再查看详情。");
    }
    artifactDetailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestVersion === artifactDetailRequestVersion) {
      artifactDetailLoading.value = false;
      openingArtifactId.value = null;
    }
  }
}

/** Cancels stale Artifact detail requests and clears the closed drawer state. */
function handleArtifactDetailOpenChange(open: boolean): void {
  if (open) return;
  artifactDetailRequestVersion += 1;
  openingArtifactId.value = null;
  artifactDetailLoading.value = false;
  artifactDetailError.value = "";
  artifactFilesError.value = "";
  artifactDetail.value = null;
  artifactDetailFiles.value = [];
  artifactDetailFields.value = [];
  artifactDetailRecord.value = null;
  artifactDetailWorkspaceId.value = null;
  artifactPreviewPath.value = "";
}

/** Switches from the Artifact drawer to the existing validated runtime evidence directory. */
async function openArtifactRuntimeEvidence(): Promise<void> {
  const record = artifactDetailRecord.value;
  if (!record) return;
  artifactDetailDrawerOpen.value = false;
  await openContractEvidence(record);
}

function artifactStatusColor(status: string | null | undefined): string {
  if (status === "approved" || status === "published" || status === "valid") return "success";
  if (status === "rejected" || status === "invalid" || status === "missing") return "error";
  if (status === "draft" || status === "staged" || status === "warning") return "warning";
  return "default";
}

function formatArtifactSize(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Formats persisted Artifact metadata as stable diagnostic JSON. */
function formatArtifactMetadata(artifact: Artifact): string {
  return JSON.stringify(artifact.metadata ?? {}, null, 2);
}

function contractTypeLabel(type: OrchestrationMetricContractType): string {
  if (type === "gate") return "Gate";
  if (type === "acceptance") return "验收标准";
  if (type === "artifact") return "Artifact";
  if (type === "output_field") return "输出字段";
  return "运行证据";
}

function contractStatusLabel(status: OrchestrationMetricContractEvaluationStatus): string {
  if (status === "passed") return "已通过";
  if (status === "failed") return "未通过";
  if (status === "missing_evidence") return "缺少证据";
  return "未评价";
}

function contractStatusColor(status: OrchestrationMetricContractEvaluationStatus): string {
  if (status === "passed") return "success";
  if (status === "failed") return "error";
  if (status === "missing_evidence") return "warning";
  return "default";
}

function contractDetailRowKey(item: OrchestrationMetricContractDetailItem): string {
  return JSON.stringify([
    item.instance.sourceUserId,
    item.instance.workspaceId,
    item.instance.instanceId,
    item.nodeExecutionId ?? "",
    item.contractType,
    item.contractKey,
  ]);
}

function statusColor(status: OrchestrationMetricStatus): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "running") return "blue";
  return "default";
}

/** Maps execution-level node states to compact status tags. */
function nodeExecutionStatusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "running" || status === "artifact-writing" || status === "gate-checking") return "blue";
  if (status.startsWith("waiting")) return "gold";
  return "default";
}

function freshnessLabel(status: OrchestrationMetricFreshnessStatus): string {
  if (status === "fresh") return "已刷新";
  if (status === "stale") return "快照可用";
  if (status === "offline") return "来源离线";
  if (status === "error") return "刷新异常";
  if (status === "generating") return "生成中";
  return "暂无数据";
}

/** Translates server-owned data-quality dimensions without changing their meaning. */
function dataQualityDimensionLabel(value: string): string {
  if (value === "complete") return "完整";
  if (value === "partial") return "部分数据";
  if (value === "unavailable") return "不可用";
  if (value === "fresh") return "最新";
  if (value === "stale") return "快照";
  if (value === "offline") return "离线";
  if (value === "generating") return "刷新中";
  if (value === "empty") return "无数据";
  if (value === "valid") return "有效";
  if (value === "conflicted") return "冲突";
  if (value === "error") return "异常";
  return value;
}

/** 将时效状态转换为业务可理解的概览短标签，其余维度保持服务端原义。 */
function dataQualityOverviewDimensionLabel(value: string): string {
  if (value === "partial") return "部分";
  return dataQualityDimensionLabel(value);
}

watch(
  () => [
    selectedScopeKind.value,
    selectedScopeId.value,
    filters.range,
    filters.workflowIds.join(","),
    filters.roleStages.join(","),
    filters.models.join(","),
    filters.dimension,
    filters.costDimension,
    filters.codeAttributionDimension,
    filters.page,
    filters.pageSize,
    activeTab.value,
    correlationXMetric.value,
    correlationYMetric.value,
    experimentView.value,
    focusedCohortKey.value,
  ],
  syncViewContext,
);

watch([correlationXMetric, correlationYMetric], () => {
  if (!summary.value || !canQuery.value) return;
  void loadCorrelation(++correlationRequestVersion, dashboardRequestVersion);
});

/** Rebinds trend sizing whenever conditional rendering creates a new canvas element. */
watch(trendCanvasElement, (element) => {
  trendResizeObserver?.disconnect();
  trendResizeObserver = null;
  if (element) void nextTick(bindTrendResizeObserver);
});

// 独立监听会话标量，避免 userSummary 等价替换时因新数组引用而重置已渲染图表。
watch(
  [
    () => config.serverWsOrigin,
    () => String(config.userSummary?.userId ?? ""),
    () => config.sessionToken ?? "",
  ],
  ([serverWsOrigin, userId, sessionToken]) => {
    resetMetricSessionState(serverWsOrigin, userId, sessionToken);
    if (componentActive) void initializeMetricView();
  },
);

watch(activeTab, (tab) => {
  if (tab === "conformance" && summary.value && !conformance.value && !conformanceLoading.value) {
    void loadConformance(++conformanceRequestVersion);
  }
  if ((tab === 'costs' || tab === 'overview') && summary.value && !costs.value && !costsLoading.value) {
    costsPage.value = 1;
    void loadCosts(++costsRequestVersion);
  }
  if (tab === "experiments" && summary.value) {
    if (experimentView.value === "comparison" && !experiments.value && !experimentsLoading.value) {
      void loadExperiments(++experimentsRequestVersion);
    }
    if (experimentView.value !== "comparison" && !evaluationSetsLoaded.value && !evaluationSetsLoading.value) {
      void loadEvaluationSets(++evaluationSetsRequestVersion);
    }
  }
  if (tab === "delivery" && canQuery.value && !delivery.value && !deliveryLoading.value) {
    void loadDelivery(++deliveryRequestVersion);
  }
  if ((tab === "code_attribution" || tab === 'overview') && canQuery.value && !codeAttribution.value && !codeAttributionLoading.value) {
    codeAttributionPage.value = 1;
    void loadCodeAttribution(++codeAttributionRequestVersion);
  }
  void nextTick(bindTrendResizeObserver);
});

watch(experimentView, (view) => {
  if (activeTab.value !== "experiments" || !summary.value) return;
  if (view === "comparison" && !experiments.value && !experimentsLoading.value) {
    void loadExperiments(++experimentsRequestVersion);
  }
  if (view !== "comparison" && !evaluationSetsLoaded.value && !evaluationSetsLoading.value) {
    void loadEvaluationSets(++evaluationSetsRequestVersion);
  }
});

watch(selectedScopeKind, (scopeKind) => {
  if (scopeKind !== "mine" && experimentView.value === "controlled") experimentView.value = "comparison";
});

/** Clears visible state and invalidates requests when the Server or account session changes. */
function resetMetricSessionState(serverWsOrigin: string, userId: string, sessionToken: string): void {
  metricRequestController.value.abort();
  metricRequestController.value = new AbortController();
  synchronizeOrchestrationMetricCacheSession(serverWsOrigin, userId, sessionToken);
  exportRequestVersion += 1;
  if (exportPollTimer) clearTimeout(exportPollTimer);
  exportPollTimer = null;
  exportJob.value = null;
  exportLoading.value = false;
  exportPollError.value = "";
  metricEvidenceRequestVersion += 1;
  openingEvidenceInstanceId.value = null;
  evidenceDrawerOpen.value = false;
  evidenceLoading.value = false;
  evidenceMonitorLoading.value = false;
  evidenceError.value = "";
  evidenceData.value = null;
  evidenceTarget.value = null;
  closeSourceHealth();
  closeNodeExecutions();
  closeContractDetails();
  artifactDetailDrawerOpen.value = false;
  handleArtifactDetailOpenChange(false);
  closeImprovementComposer();
  improvementCreating.value = false;
  improvementCohort.value = null;
  improvementWorkspaceId.value = null;
  improvementCandidatesError.value = "";
  improvementIntakesError.value = "";
  evaluationScoreOpen.value = false;
  evaluationScoreSaving.value = false;
  evaluationScoreItem.value = null;
  evaluationScoreExplanation.value = "";
  evaluationSetCreating.value = false;
  evaluationSetItemsLoading.value = false;
  initializationRequestVersion += 1;
  scopesRequestVersion += 1;
  candidateRequestVersion += 1;
  sourceRetryRequestVersion += 1;
  dashboardRequestVersion += 1;
  refreshRequestVersion += 1;
  analysisRequestVersion += 1;
  flowRequestVersion += 1;
  conformanceRequestVersion += 1;
  costsRequestVersion += 1;
  experimentsRequestVersion += 1;
  evaluationSetsRequestVersion += 1;
  deliveryRequestVersion += 1;
  codeAttributionRequestVersion += 1;
  correlationRequestVersion += 1;
  sourceHealthRequestVersion += 1;
  deliveryEntryProbeVersion += 1;
  deliveryEntryState.value = "idle";
  activeQuerySnapshot = null;
  renderedMetricContextKey = "";
  viewContextReady = false;
  scopes.value = [];
  candidates.value = [];
  selectedScopeKind.value = "mine";
  selectedScopeId.value = null;
  summary.value = null;
  analysis.value = null;
  bottlenecks.value = null;
  correlations.value = null;
  flow.value = null;
  sourceHealth.value = null;
  sourceHealthError.value = "";
  retryingSourceKey.value = null;
  scopesLoading.value = false;
  candidatesLoading.value = false;
  refreshing.value = false;
  summaryLoading.value = false;
  analysisLoading.value = false;
  flowLoading.value = false;
  conformanceLoading.value = false;
  costsLoading.value = false;
  experimentsLoading.value = false;
  evaluationSetsLoading.value = false;
  evaluationSetsError.value = "";
  deliveryLoading.value = false;
  codeAttributionLoading.value = false;
  correlationLoading.value = false;
  sourceHealthLoading.value = false;
  resetLazyMetricViewsForContextChange();
}

/** Loads current authorization, restores URL state, and queries only for the latest session. */
async function initializeMetricView(): Promise<void> {
  const requestVersion = ++initializationRequestVersion;
  initializing.value = true;
  try {
    await loadScopes(false);
    if (!componentActive || requestVersion !== initializationRequestVersion) return;
    restoreViewContext();
    viewContextReady = true;
    syncViewContext();
    if (requiresCandidate.value && selectedScopeId.value) {
      candidates.value = [{ kind: candidateKind.value, id: selectedScopeId.value, label: selectedScopeId.value, description: "" }];
    }
    await loadDashboard();
    if (!componentActive || requestVersion !== initializationRequestVersion) return;
    await nextTick();
    bindTrendResizeObserver();
  } finally {
    if (componentActive && requestVersion === initializationRequestVersion) initializing.value = false;
  }
}

onMounted(async () => {
  componentActive = true;
  viewContextReady = false;
  await initializeMetricView();
});

onBeforeUnmount(() => {
  metricRequestController.value.abort();
  clearOrchestrationMetricQueryCache();
  componentActive = false;
  viewContextReady = false;
  exportRequestVersion += 1;
  metricEvidenceRequestVersion += 1;
  initializationRequestVersion += 1;
  scopesRequestVersion += 1;
  candidateRequestVersion += 1;
  sourceRetryRequestVersion += 1;
  summaryCommitVersion += 1;
  dashboardRequestVersion += 1;
  refreshRequestVersion += 1;
  analysisRequestVersion += 1;
  flowRequestVersion += 1;
  nodeExecutionRequestVersion += 1;
  contractDetailRequestVersion += 1;
  artifactDetailRequestVersion += 1;
  correlationRequestVersion += 1;
  conformanceRequestVersion += 1;
  costsRequestVersion += 1;
  experimentsRequestVersion += 1;
  evaluationSetsRequestVersion += 1;
  improvementCandidatesRequestVersion += 1;
  improvementIntakesRequestVersion += 1;
  deliveryRequestVersion += 1;
  codeAttributionRequestVersion += 1;
  sourceHealthRequestVersion += 1;
  trendResizeObserver?.disconnect();
  if (exportPollTimer) clearTimeout(exportPollTimer);
});
</script>

<template>
  <div class="orchestration-metrics">
    <div class="orchestration-metrics__toolbar">
      <div class="orchestration-metrics__toolbar-fields">
        <a-select
          v-model:value="selectedScopeKind"
          class="orchestration-metrics__field orchestration-metrics__field--scope"
          :options="scopeOptions"
          :loading="scopesLoading"
          @change="handleScopeChange"
        />
        <a-select v-model:value="filters.range" class="orchestration-metrics__field" :options="rangeOptions" />
        <a-select
          v-model:value="filters.workflowIds"
          mode="multiple"
          class="orchestration-metrics__field orchestration-metrics__field--wide"
          :options="workflowOptions"
          placeholder="全部工作流"
          :max-tag-count="1"
          allow-clear
        />
        <a-select
          v-model:value="filters.roleStages"
          mode="multiple"
          class="orchestration-metrics__field orchestration-metrics__field--wide"
          :options="roleStageOptions"
          placeholder="全部角色阶段"
          :max-tag-count="1"
          allow-clear
        />
        <a-select
          v-model:value="filters.models"
          mode="multiple"
          class="orchestration-metrics__field orchestration-metrics__field--wide"
          :options="modelOptions"
          placeholder="全部模型"
          :max-tag-count="1"
          allow-clear
        />
        <a-button
          class="orchestration-metrics__query-button"
          type="primary"
          :disabled="!canQuery || loading"
          @click="applyFilters"
        >
          <template #icon><SearchOutlined /></template>
          查询
        </a-button>
      </div>
      <div class="orchestration-metrics__toolbar-actions">
        <a-tooltip title="来源健康">
          <a-button type="text" aria-label="打开来源健康" :disabled="!canQuery" @click="openSourceHealth">
            <template #icon><DatabaseOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-popover title="查询说明" placement="bottomRight" trigger="click">
          <template #content>
            <div class="orchestration-metrics__action-help">
              <p><strong>查询</strong>：按当前筛选条件读取已有统计快照，不重新采集数据。</p>
              <p><strong>增量刷新</strong>：只采集上次刷新后的变化数据，流量小，日常使用。</p>
              <p><strong>全量刷新</strong>：重新采集全部数据并清理已删除实例，建议在数据异常时使用或在低峰期自动执行。</p>
            </div>
          </template>
          <a-button type="text" title="查询说明">
            <template #icon><InfoCircleOutlined /></template>
          </a-button>
        </a-popover>
        <a-tag :class="freshnessClass" :bordered="false">
          {{ freshnessLabel(freshnessStatus) }}
        </a-tag>
        <span class="orchestration-metrics__freshness-time">
          最近更新：{{ freshnessUpdatedAt ? formatDateTime(freshnessUpdatedAt) : "暂无记录" }}
        </span>
        <a-button :disabled="!canQuery || refreshing" :loading="refreshing" @click="refreshMetrics('incremental')">
          <template #icon><SyncOutlined /></template>
          增量刷新
        </a-button>
        <a-button :disabled="!canQuery || refreshing" :loading="refreshing" @click="refreshMetrics('full')">
          <template #icon><SyncOutlined /></template>
          全量刷新
        </a-button>
        <a-dropdown :disabled="!summary || exportLoading">
          <a-button :loading="exportLoading"><template #icon><DownloadOutlined /></template>导出</a-button>
          <template #overlay><a-menu @click="handleExportMenuClick"><a-menu-item key="summary">汇总 CSV</a-menu-item><a-menu-item key="audit_bundle">审计证据包 JSON</a-menu-item><a-menu-item key="instances" :disabled="!detailsAllowed">实例 CSV</a-menu-item><a-menu-item key="nodes" :disabled="!detailsAllowed">节点 CSV</a-menu-item></a-menu></template>
        </a-dropdown>
      </div>
    </div>

    <div v-if="exportJob" class="orchestration-metrics__export-status">
      <span>导出任务 {{ exportJob.status }}<template v-if="exportJob.rowCount">，{{ exportJob.rowCount }} 行</template></span>
      <a-button v-if="exportJob.status === 'queued' || exportJob.status === 'running'" size="small" @click="cancelExport"><template #icon><StopOutlined /></template>取消</a-button>
      <a-button v-if="exportPollError && (exportJob.status === 'queued' || exportJob.status === 'running')" size="small" @click="pollExport"><template #icon><SyncOutlined /></template>重试状态</a-button>
      <a-button v-if="exportJob.status === 'succeeded'" size="small" type="primary" @click="downloadExport"><template #icon><DownloadOutlined /></template>下载</a-button>
      <span v-if="exportJob.errorMessage" class="orchestration-metrics__export-error">{{ exportJob.errorMessage }}</span>
      <span v-if="exportPollError" class="orchestration-metrics__export-error">{{ exportPollError }}</span>
    </div>

    <a-alert
      v-if="requiresCandidate && !selectedScopeId"
      type="info"
      show-icon
      message="请选择统计范围"
      :description="candidateKind === 'enterprise' ? '选择企业后展示该企业授权范围内的编排度量。' : '选择用户后展示该用户自己的编排度量。'"
    />
    <a-alert
      v-else-if="errorMessage"
      :type="errorCode === 'ORCH_METRICS_SCOPE_FORBIDDEN' || errorCode === 'ROLE_SCOPE_FORBIDDEN' ? 'warning' : 'error'"
      show-icon
      :message="errorMessage"
    />
    <a-alert
      v-else-if="showFreshnessNotice"
      :type="freshnessStatus === 'fresh' ? 'success' : freshnessStatus === 'offline' ? 'info' : 'warning'"
      show-icon
      closable
      :message="freshnessNoticeMessage"
      @close="dismissFreshnessNotice"
    />
    <a-alert
      v-if="privacyMessage"
      type="warning"
      show-icon
      :message="privacyMessage"
      class="orchestration-metrics__privacy-alert"
    />
    <div v-if="initializing" class="orchestration-metrics__initial-loading" role="status" aria-live="polite">
      <a-spin size="large" />
      <span>度量数据加载中...</span>
    </div>
    <a-skeleton v-else-if="loading && !summary" active :paragraph="{ rows: 8 }" />
    <a-empty v-else-if="showEmpty && activeTab !== 'delivery' && activeTab !== 'code_attribution'" :description="emptyDescription">
      <a-button v-if="deliveryEntryState === 'available'" @click="activeTab = 'delivery'">查看交付效能</a-button>
    </a-empty>

    <template v-else-if="summary || activeTab === 'delivery' || activeTab === 'code_attribution'">
      <a-select
        v-model:value="activeTab"
        class="orchestration-metrics__mobile-view-select"
        :options="mobileViewOptions"
        aria-label="选择度量视图"
      />
      <a-tabs v-model:active-key="activeTab" class="orchestration-metrics__tabs">
        <a-tab-pane key="overview" tab="概览" />
        <a-tab-pane key="flow" tab="流程效率" />
        <!-- <a-tab-pane key="conformance" tab="流程符合性" /> -->
        <a-tab-pane key="costs" tab="Token 消耗" />
        <a-tab-pane key="code_attribution" tab="代码贡献" />
        <a-tab-pane key="specification" tab="规格质量" />
        <a-tab-pane key="experiments" tab="评估实验" />
        <a-tab-pane key="delivery" tab="交付效能 DORA" />
        <a-tab-pane key="trend" tab="趋势对比" />
        <!-- <a-tab-pane key="bottleneck" tab="多信号节点异常" /> -->
        <a-tab-pane key="correlation" tab="质量关联" />
      </a-tabs>

      <CodeAttributionView
        v-if="activeTab === 'code_attribution'"
        :data="codeAttribution"
        :loading="codeAttributionLoading"
        :error="codeAttributionError"
        :dimension="filters.codeAttributionDimension"
        :page="codeAttributionPage"
        :page-size="codeAttributionPageSize"
        :opening-evidence-instance-id="openingEvidenceInstanceId"
        @dimension-change="handleCodeAttributionDimensionChange"
        @page-change="handleCodeAttributionPageChange"
        @open-evidence="openCodeAttributionEvidence"
        @reload="loadCodeAttribution(++codeAttributionRequestVersion)"
      />

      <section v-else-if="activeTab === 'costs'" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head">
          <div class="orchestration-metrics__section-actions">
            <span>Trace {{ costs?.total ?? 0 }}</span>
            <a-segmented
              v-model:value="filters.costDimension"
              :options="costDimensionOptions"
              data-testid="cost-dimension"
              @change="handleCostDimensionChange"
            />
          </div>
        </div>
        <a-skeleton v-if="costsLoading && !costs" active :paragraph="{ rows: 6 }" />
        <a-alert v-if="costsError" type="warning" show-icon closable :message="costsError">
          <template #action><a-button size="small" @click="loadCosts(++costsRequestVersion)">重试</a-button></template>
        </a-alert>
        <template v-if="costs">
          <div class="orchestration-metrics__flow-summary">
            <div><span>模型调用</span><strong>{{ costs.totals.modelCallCount ?? "受保护" }}</strong></div>
            <div><span>未命中缓存输入</span><strong>{{ costs.totals.uncachedInputTokens?.toLocaleString() ?? "受保护" }}</strong></div>
            <div><span>命中缓存输入</span><strong>{{ costs.totals.cachedInputTokens?.toLocaleString() ?? "受保护" }}</strong></div>
            <div><span>输出 Token</span><strong>{{ costs.totals.outputTokens?.toLocaleString() ?? "受保护" }}</strong></div>
          </div>
          <a-table :data-source="costs.groups" :pagination="false" :row-key="costGroupRowKey" size="small" :scroll="{ x: costs.dimension === 'model' ? 1040 : 780 }">
            <a-table-column title="分组" key="dimensionLabel" :width="220"><template #default="{ record }"><span :title="record.dimensionKey">{{ record.dimensionLabel || '未记录' }}</span> <a-tag v-if="record.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag></template></a-table-column>
            <a-table-column v-if="costs.dimension === 'model'" title="供应商" key="providerId" :width="130"><template #default="{ record }">{{ record.providerId || '历史未记录' }}</template></a-table-column>
            <a-table-column v-if="costs.dimension === 'model'" title="凭据来源" key="credentialSource" :width="140"><template #default="{ record }">{{ credentialSourceLabel(record.credentialSource) }}</template></a-table-column>
            <a-table-column title="Trace" data-index="traceCount" key="traceCount" />
            <a-table-column title="调用" key="modelCallCount"><template #default="{ record }">{{ record.modelCallCount ?? "受保护" }}</template></a-table-column>
            <a-table-column title="未命中缓存输入" key="uncachedInputTokens"><template #default="{ record }">{{ record.uncachedInputTokens?.toLocaleString() ?? "受保护" }}</template></a-table-column>
            <a-table-column title="命中缓存输入" key="cachedInputTokens"><template #default="{ record }">{{ record.cachedInputTokens?.toLocaleString() ?? "受保护" }}</template></a-table-column>
            <a-table-column title="输出 Token" key="outputTokens"><template #default="{ record }">{{ record.outputTokens?.toLocaleString() ?? "受保护" }}</template></a-table-column>
          </a-table>
          <div class="orchestration-metrics__section-head"><h3>调用归属</h3><span>当前页 {{ costs.items.length }}</span></div>
          <a-table :data-source="costs.items" :pagination="false" row-key="promptSnapshotId" size="small" :scroll="{ x: 1280 }">
            <a-table-column title="时间" :width="170"><template #default="{ record }">{{ formatDateTime(record.startedAt) }}</template></a-table-column>
            <a-table-column title="引擎 / 模型" :width="220"><template #default="{ record }">{{ record.engine }} / {{ record.model || '未记录' }}</template></a-table-column>
            <a-table-column title="供应商" :width="130"><template #default="{ record }">{{ record.providerId || '历史未记录' }}</template></a-table-column>
            <a-table-column title="凭据来源" :width="140"><template #default="{ record }">{{ credentialSourceLabel(record.credentialSource) }}</template></a-table-column>
            <a-table-column title="未命中缓存输入" :width="150"><template #default="{ record }">{{ formatTraceUncachedInputTokens(record) }}</template></a-table-column>
            <a-table-column title="命中缓存输入" :width="130"><template #default="{ record }">{{ record.cachedInputTokens.toLocaleString() }}</template></a-table-column>
            <a-table-column title="输出 Token" :width="130"><template #default="{ record }">{{ record.outputTokens.toLocaleString() }}</template></a-table-column>
            <a-table-column title="证据" :width="110"><template #default="{ record }"><a-tag :color="record.evidenceStatus === 'complete' ? 'green' : 'orange'">{{ record.evidenceStatus === 'complete' ? '完整' : '待补齐' }}</a-tag></template></a-table-column>
            <a-table-column title="操作" :width="116" fixed="right">
              <template #default="{ record }">
                <a-tooltip :title="costTraceEvidenceTooltip(record)">
                  <span>
                    <a-button
                      type="link"
                      size="small"
                      :disabled="isSyntheticMetricInstanceId(record.sourceInstanceId)"
                      :loading="openingEvidenceInstanceId === record.sourceInstanceId"
                      @click="openCostTraceEvidence(record)"
                    >
                      <template #icon><EyeOutlined /></template>
                      查看调用
                    </a-button>
                  </span>
                </a-tooltip>
              </template>
            </a-table-column>
          </a-table>
          <div v-if="costs.total > 0" class="orchestration-metrics__pagination">
            <span>{{ costs.items.length }} / {{ costs.total }}</span>
            <a-pagination
              :current="costs.page"
              :page-size="costs.pageSize"
              :total="costs.total"
              :show-size-changer="true"
              :page-size-options="['10', '20', '50', '100']"
              @change="handleCostsPageChange"
              @show-size-change="handleCostsPageChange"
            />
          </div>
        </template>
        <a-empty v-else description="当前范围暂无可绑定的 Agent Trace" />
      </section>

      <section v-else-if="activeTab === 'delivery'" class="orchestration-metrics__deep-view orchestration-metrics__deep-view--delivery">
        <div class="orchestration-metrics__section-head">
          <h3>真实交付结果</h3>
          <div class="orchestration-metrics__section-actions">
            <span>{{ delivery?.total ?? 0 }} 条事实</span>
            <a-popover trigger="click" placement="bottomRight">
              <template #content><div class="orchestration-metrics__metric-definition"><strong>DORA 与返工口径</strong><dl>
                <div><dt>部署频率</dt><dd>成功生产部署数 ÷ 查询周期天数。</dd></div>
                <div><dt>前置时间</dt><dd>成功生产部署时间减去同仓库、同 Commit 的提交时间，展示中位数。</dd></div>
                <div><dt>失败率</dt><dd>失败或存在明确回滚/恢复的生产部署 ÷ 全部终态生产部署。</dd></div>
                <div><dt>恢复时间</dt><dd>受影响部署到首个成功回滚或恢复的耗时中位数。</dd></div>
                <div><dt>返工率</dt><dd>标记为返工的成功生产部署 ÷ 已完整标记返工属性的成功生产部署。</dd></div>
                <div><dt>不可判定</dt><dd>周期内有未对账批次、覆盖不连续或必要关联缺失时不输出推测值。</dd></div>
              </dl></div></template>
              <a-button type="text" size="small" aria-label="查看交付指标口径"><template #icon><InfoCircleOutlined /></template></a-button>
            </a-popover>
          </div>
        </div>
        <a-skeleton v-if="deliveryLoading && !delivery" active :paragraph="{ rows: 6 }" />
        <a-alert v-else-if="deliveryError" type="warning" show-icon :message="deliveryError" />
        <template v-else-if="delivery">
          <a-alert
            v-if="delivery.reconciliation.status !== 'matched'"
            type="warning"
            show-icon
            closable
            message="当前时间范围尚未被已对账交付批次完整覆盖，DORA 指标保持不可判定。"
          />
          <div class="orchestration-metrics__flow-summary orchestration-metrics__flow-summary--delivery">
            <div><span>部署频率</span><strong>{{ formatDoraValue(delivery.dora.deploymentFrequency) }}</strong><small>{{ doraAvailabilityText(delivery.dora.deploymentFrequency) }}</small></div>
            <div><span>变更前置时间</span><strong>{{ formatDoraValue(delivery.dora.leadTimeForChanges) }}</strong><small>{{ doraAvailabilityText(delivery.dora.leadTimeForChanges) }}</small></div>
            <div><span>变更失败率</span><strong>{{ formatDoraValue(delivery.dora.changeFailureRate) }}</strong><small>{{ doraAvailabilityText(delivery.dora.changeFailureRate) }}</small></div>
            <div><span>失败部署恢复时间</span><strong>{{ formatDoraValue(delivery.dora.failedDeploymentRecoveryTime) }}</strong><small>{{ doraAvailabilityText(delivery.dora.failedDeploymentRecoveryTime) }}</small></div>
            <div><span>部署返工率</span><strong>{{ formatDoraValue(delivery.dora.deploymentReworkRate) }}</strong><small>{{ doraAvailabilityText(delivery.dora.deploymentReworkRate) }}</small></div>
          </div>
          <div class="orchestration-metrics__section-head"><h3>交付趋势</h3><span>{{ delivery.trend.length }} 个周期</span></div>
          <a-table :data-source="delivery.trend" :pagination="false" row-key="bucketStartAt" size="small" :scroll="{ x: 980, y: 360 }">
            <a-table-column title="周期" :width="260"><template #default="{ record }">{{ formatDateTime(record.bucketStartAt) }} - {{ formatDateTime(record.bucketEndAt) }}</template></a-table-column>
            <a-table-column title="部署频率" :width="130"><template #default="{ record }">{{ formatDoraValue(record.deploymentFrequency) }}</template></a-table-column>
            <a-table-column title="变更前置时间" :width="150"><template #default="{ record }">{{ formatDoraValue(record.leadTimeForChanges) }}</template></a-table-column>
            <a-table-column title="变更失败率" :width="130"><template #default="{ record }">{{ formatDoraValue(record.changeFailureRate) }}</template></a-table-column>
            <a-table-column title="恢复时间" :width="140"><template #default="{ record }">{{ formatDoraValue(record.failedDeploymentRecoveryTime) }}</template></a-table-column>
            <a-table-column title="部署返工率" :width="130"><template #default="{ record }">{{ formatDoraValue(record.deploymentReworkRate) }}</template></a-table-column>
          </a-table>
          <div class="orchestration-metrics__section-head">
            <h3>交付事实</h3>
            <span>提交 {{ delivery.counts.commit }} · PR {{ delivery.counts.pull_request }} · 测试 {{ delivery.counts.test_run }} · 部署 {{ delivery.counts.deployment }}</span>
          </div>
          <a-table :data-source="delivery.facts" :pagination="false" row-key="id" size="small" :scroll="{ x: 1180, y: 420 }">
            <a-table-column title="时间" :width="170"><template #default="{ record }">{{ formatDateTime(record.eventAt) }}</template></a-table-column>
            <a-table-column title="类型" :width="90"><template #default="{ record }">{{ deliveryKindLabel(record.kind) }}</template></a-table-column>
            <a-table-column title="状态" :width="90"><template #default="{ record }">{{ deliveryStatusLabel(record.status) }}</template></a-table-column>
            <a-table-column title="来源" data-index="sourceSystem" :width="130" />
            <a-table-column title="仓库" data-index="repository" :ellipsis="true" :width="220" />
            <a-table-column title="Commit / PR" :width="180"><template #default="{ record }">{{ record.commitSha || record.pullRequestId || '-' }}</template></a-table-column>
            <a-table-column title="环境" :width="110"><template #default="{ record }">{{ record.environment || '-' }}</template></a-table-column>
            <a-table-column title="编排实例" data-index="sourceInstanceId" :ellipsis="true" :width="220" />
          </a-table>
          <a-pagination
            v-if="delivery.total > deliveryPageSize"
            v-model:current="deliveryPage"
            v-model:page-size="deliveryPageSize"
            :total="delivery.total"
            size="small"
            show-size-changer
            @change="loadDelivery(++deliveryRequestVersion)"
            @show-size-change="loadDelivery(++deliveryRequestVersion)"
          />
          <div class="orchestration-metrics__section-head">
            <h3>来源对账</h3>
            <span>匹配 {{ delivery.reconciliation.matchedBatchCount }} · 未匹配 {{ delivery.reconciliation.unreconciledBatchCount }}</span>
          </div>
          <a-table :data-source="delivery.batches" :pagination="false" row-key="id" size="small" :scroll="{ x: 900 }">
            <a-table-column title="来源 / 批次" :width="240"><template #default="{ record }">{{ record.sourceSystem }} / {{ record.sourceBatchId }}</template></a-table-column>
            <a-table-column title="时间范围" :width="300"><template #default="{ record }">{{ formatDateTime(record.periodFrom) }} - {{ formatDateTime(record.periodTo) }}</template></a-table-column>
            <a-table-column title="记录数" :width="140"><template #default="{ record }">{{ record.acceptedRecordCount }} / {{ record.sourceRecordCount }}</template></a-table-column>
            <a-table-column title="对账" :width="110"><template #default="{ record }">{{ record.reconciliationStatus === 'matched' ? '已匹配' : '未匹配' }}</template></a-table-column>
            <a-table-column title="更新时间" :width="170"><template #default="{ record }">{{ formatDateTime(record.updatedAt) }}</template></a-table-column>
          </a-table>
          <a-empty v-if="delivery.total === 0" :image="simpleEmptyImage" description="当前时间范围暂无交付事实" />
        </template>
      </section>

      <section v-else-if="activeTab === 'experiments'" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head">
          <h3>评估实验</h3>
          <a-segmented
            v-model:value="experimentView"
            :options="experimentViewOptions"
          />
        </div>
        <template v-if="experimentView === 'comparison'">
          <div class="orchestration-metrics__section-head">
            <h3>配置 Cohort 周期对比</h3>
            <div class="orchestration-metrics__section-actions">
              <span>{{ experiments?.total ?? 0 }} 个配置</span>
              <a-popover trigger="click" placement="bottomRight"><template #content><div class="orchestration-metrics__metric-definition"><strong>评估实验口径</strong><dl><div><dt>覆盖率</dt><dd>有明确通过或失败结论的 Trace ÷ 适用 Trace；未评估不进入分母，缺少证据进入分母。</dd></div><div><dt>通过率</dt><dd>通过的已评估 Trace ÷ 全部已评估 Trace。</dd></div><div><dt>95% CI</dt><dd>通过率的 95% Wilson 置信区间，用于表达样本不确定性。</dd></div><div><dt>可比条件</dt><dd>流程、节点、角色、Prompt 定义、引擎、模型、推理强度和评估器配置一致，覆盖率 100%，当前与对比周期各至少 20 个有效样本。</dd></div></dl></div></template><a-button type="text" size="small" aria-label="查看评估实验口径"><template #icon><InfoCircleOutlined /></template></a-button></a-popover>
            </div>
          </div>
          <div v-if="experiments" class="orchestration-metrics__flow-summary">
            <div><span>当前有效样本</span><strong>{{ experiments?.currentTotals.evaluatedCount ?? "受保护" }}</strong></div>
            <div><span>当前证据覆盖</span><strong>{{ formatRate(experiments.currentTotals.coverageRate) }}</strong></div>
            <div><span>对比有效样本</span><strong>{{ experiments?.comparisonTotals.evaluatedCount ?? "受保护" }}</strong></div>
            <div><span>对比证据覆盖</span><strong>{{ formatRate(experiments.comparisonTotals.coverageRate) }}</strong></div>
          </div>
          <div class="orchestration-metrics__experiment-filters">
            <a-select
              v-model:value="experimentCriteria"
              mode="multiple"
              allow-clear
              placeholder="全部评估标准"
              :max-tag-count="1"
              @change="handleExperimentFiltersChange"
            >
              <a-select-option value="trace_evidence_integrity">运行证据完整性</a-select-option>
              <a-select-option value="tool_path_efficiency">工具路径效率</a-select-option>
            </a-select>
            <a-select v-model:value="experimentComparability" @change="handleExperimentFiltersChange">
              <a-select-option value="all">全部可比性</a-select-option>
              <a-select-option value="comparable">仅可比较</a-select-option>
              <a-select-option value="incomparable">仅不可比较</a-select-option>
            </a-select>
          </div>
          <a-alert v-if="focusedCohortMissing" type="warning" show-icon message="历史配置未定位；该证据可能来自旧版 Cohort 身份，或不在当前筛选范围内。" />
          <a-skeleton v-if="experimentsLoading && !experiments" active :paragraph="{ rows: 6 }" />
          <a-alert v-else-if="experimentsError" type="warning" show-icon :message="experimentsError" />
          <template v-else-if="experiments">
            <div class="orchestration-metrics__cohort-table">
              <a-table
                :data-source="experiments.cohorts"
                :pagination="false"
                row-key="cohortKey"
                size="small"
                :scroll="{ x: 1100 }"
                :custom-row="cohortRowAttributes"
              >
                <template #expandedRowRender="{ record }">
                  <dl class="orchestration-metrics__cohort-details">
                    <div><dt>Workflow</dt><dd :title="record.workflowSnapshotHash">{{ record.workflowSnapshotHash }}</dd></div>
                    <div><dt>Role</dt><dd :title="record.roleSnapshotHash">{{ record.roleSnapshotHash }}</dd></div>
                    <div><dt>Prompt 定义</dt><dd :title="record.promptDefinitionHash">{{ record.promptDefinitionHash }}</dd></div>
                    <div><dt>评估器</dt><dd>{{ record.evaluatorId }} / {{ record.evaluatorVersion }}</dd></div>
                  </dl>
                </template>
                <a-table-column title="节点 / 评估标准" :width="220">
                  <template #default="{ record }"><strong>{{ record.nodeId }}</strong><br /><small>{{ evaluationCriterionLabel(record.criterion) }}</small></template>
                </a-table-column>
                <a-table-column title="引擎 / 模型" :width="180">
                  <template #default="{ record }">{{ record.engine }} / {{ record.model || "未记录" }}<br /><small>推理强度 {{ record.effort || "未记录" }}</small></template>
                </a-table-column>
                <a-table-column title="当前周期" :width="190">
                  <template #default="{ record }">
                    <a-tag v-if="record.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag>
                    <template v-else-if="record.current"><strong>{{ formatRate(record.current.passRate) }}</strong><span> · {{ record.current.evaluatedCount }} 样本</span><br /><small>覆盖 {{ formatRate(record.current.coverageRate) }} · 95% CI {{ formatConfidenceInterval(record.current) }}</small></template>
                    <span v-else>-</span>
                  </template>
                </a-table-column>
                <a-table-column title="对比周期" :width="190">
                  <template #default="{ record }">
                    <a-tag v-if="record.comparisonPrivacy?.status === 'suppressed'" :bordered="false">受保护</a-tag>
                    <template v-else-if="record.comparison"><strong>{{ formatRate(record.comparison.passRate) }}</strong><span> · {{ record.comparison.evaluatedCount }} 样本</span><br /><small>覆盖 {{ formatRate(record.comparison.coverageRate) }} · 95% CI {{ formatConfidenceInterval(record.comparison) }}</small></template>
                    <span v-else>-</span>
                  </template>
                </a-table-column>
                <a-table-column title="结论 / 边界" :width="240">
                  <template #default="{ record }">
                    <a-tag :bordered="false" :color="experimentConclusionColor(record.conclusion)">{{ experimentConclusionLabel(record.conclusion) }}</a-tag>
                    <span v-if="record.passRateDelta != null">{{ formatRateDelta(record.passRateDelta) }}</span>
                    <div v-if="record.incompatibilityReasons.length" class="orchestration-metrics__cohort-reasons">
                      <span v-for="reason in record.incompatibilityReasons" :key="reason">{{ experimentReasonLabel(reason) }}</span>
                    </div>
                  </template>
                </a-table-column>
                <a-table-column title="操作" :width="120" fixed="right">
                  <template #default="{ record }"><a-button type="link" size="small" :disabled="record.privacy?.status === 'suppressed' || record.comparisonPrivacy?.status === 'suppressed'" @click="openImprovementComposer(record)"><template #icon><FileSearchOutlined /></template>改进需求</a-button></template>
                </a-table-column>
              </a-table>
            </div>
            <a-empty v-if="!experiments.cohorts.length" :image="simpleEmptyImage" description="当前筛选下暂无评估配置" />
            <div v-if="experiments.total > 0" class="orchestration-metrics__pagination">
              <span>{{ experiments.cohorts.length }} / {{ experiments.total }}</span>
              <a-pagination
                size="small"
                :current="experiments.page"
                :page-size="experiments.pageSize"
                :total="experiments.total"
                :show-size-changer="true"
                :page-size-options="['10', '20', '50']"
                @change="handleExperimentPageChange"
              />
            </div>
          </template>
        </template>
        <template v-else-if="experimentView === 'workbench'">
          <div class="orchestration-metrics__section-head">
            <h3>评估工作台</h3><span>{{ evaluationSets.length }} 个评估集</span>
          </div>
          <a-alert v-if="evaluationSetsError" type="error" show-icon :message="evaluationSetsError" />
          <div class="orchestration-metrics__evaluation-toolbar">
            <a-input v-model:value="evaluationSetDraft.name" placeholder="评估集名称" :maxlength="80" />
            <a-select v-model:value="evaluationSetDraft.kind">
              <a-select-option value="online_sample">在线抽样</a-select-option>
              <a-select-option value="benchmark">离线基准</a-select-option>
            </a-select>
            <a-select v-model:value="evaluationSetDraft.criterion">
              <a-select-option value="trace_evidence_integrity">运行证据完整性</a-select-option>
              <a-select-option value="tool_path_efficiency">工具路径效率</a-select-option>
            </a-select>
            <a-input-number v-model:value="evaluationSetDraft.sampleSize" :min="1" :max="200" />
            <a-button type="primary" :loading="evaluationSetCreating" @click="createEvaluationSet">创建评估集</a-button>
          </div>
          <a-table :data-source="evaluationSets" :loading="evaluationSetsLoading" row-key="id" size="small" :pagination="false" :scroll="{ x: 980 }">
            <a-table-column title="名称" data-index="name" :width="180" />
            <a-table-column title="类型" :width="100"><template #default="{ record }">{{ record.kind === "benchmark" ? "离线基准" : "在线抽样" }}</template></a-table-column>
            <a-table-column title="评估标准" data-index="criterion" :width="190" />
            <a-table-column title="样本" :width="150"><template #default="{ record }">{{ record.itemCount }} / 候选 {{ record.selectionRule.candidateCount }}</template></a-table-column>
            <a-table-column title="人工评分" :width="110"><template #default="{ record }">{{ record.humanRatedCount }}</template></a-table-column>
            <a-table-column title="基准一致率" :width="120"><template #default="{ record }">{{ formatRate(record.agreementRate) }}</template></a-table-column>
            <a-table-column title="操作" :width="90" fixed="right"><template #default="{ record }"><a-button type="link" size="small" @click="openEvaluationSet(record)">查看</a-button></template></a-table-column>
          </a-table>
          <template v-if="selectedEvaluationSet">
            <div class="orchestration-metrics__section-head"><h3>{{ selectedEvaluationSet.name }} · 样本</h3><span>{{ evaluationSetItemTotal }} 条</span></div>
            <a-table :data-source="evaluationSetItems" :loading="evaluationSetItemsLoading" row-key="id" size="small" :pagination="false" :scroll="{ x: 1120 }">
              <a-table-column title="Trace" :width="210"><template #default="{ record }"><span :title="record.promptSnapshotId">{{ shortSnapshotHash(record.promptSnapshotId) }}</span><br /><small>{{ formatDateTime(record.traceStartedAt) }}</small></template></a-table-column>
              <a-table-column title="引擎 / 模型" :width="170"><template #default="{ record }">{{ record.engine }} / {{ record.model || "未记录" }}</template></a-table-column>
              <a-table-column title="自动评估" :width="120"><template #default="{ record }">{{ record.targetEvaluationStatus || "未评估" }}</template></a-table-column>
              <a-table-column title="期望结果" :width="120"><template #default="{ record }">{{ record.expectedStatus || "未标注" }}</template></a-table-column>
              <a-table-column title="人工评分" :width="120"><template #default="{ record }">{{ record.humanEvaluationStatus || "未评分" }}</template></a-table-column>
              <a-table-column title="评分说明" data-index="humanExplanation" :ellipsis="true" :width="280" />
              <a-table-column title="操作" :width="90" fixed="right"><template #default="{ record }"><a-button type="link" size="small" @click="openEvaluationScore(record)">评分</a-button></template></a-table-column>
            </a-table>
            <a-pagination v-model:current="evaluationSetItemPage" v-model:page-size="evaluationSetItemPageSize" :total="evaluationSetItemTotal" size="small" show-size-changer @change="loadEvaluationSetItems" @show-size-change="loadEvaluationSetItems" />
          </template>
        </template>
        <ControlledExperimentsView
          v-show="experimentView === 'controlled'"
          :active="experimentView === 'controlled'"
          :evaluation-sets="evaluationSets"
          :evaluation-sets-loading="evaluationSetsLoading"
          :evaluation-sets-error="evaluationSetsError"
        />
      </section>

      <section v-else-if="activeTab === 'flow' && summary" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head"><h3>周期时间分解</h3><div class="orchestration-metrics__section-actions"><span>样本 {{ flow?.totals.sampleCount ?? 0 }}</span><a-popover trigger="click" placement="bottomRight"><template #content><div class="orchestration-metrics__metric-definition"><strong>流程效率口径</strong><dl><div><dt>墙钟时间</dt><dd>实例启动到完成或最近观测时点的总时长。</dd></div><div><dt>活跃时间</dt><dd>Agent、工具、Artifact 写入和门禁检查区间去重后的时长。</dd></div><div><dt>流动效率</dt><dd>活跃时间 ÷ 墙钟时间。</dd></div><div><dt>未分类</dt><dd>墙钟时间中没有可靠状态区间覆盖的剩余时间。</dd></div></dl></div></template><a-button type="text" size="small" aria-label="查看流程效率口径"><template #icon><InfoCircleOutlined /></template></a-button></a-popover></div></div>
        <a-skeleton v-if="flowLoading && !flow" active :paragraph="{ rows: 6 }" />
        <template v-else-if="flow">
          <a-alert v-if="flowSegmentLimitReached" type="error" show-icon message="状态区间超过计算上限，当前不输出流程效率，需缩小时间或工作流范围。" />
          <a-alert v-else-if="flow.metadata.dataQuality.consistency === 'conflicted'" type="error" show-icon message="状态区间存在冲突，当前分解已按优先级展示，需核查源事件。" />
          <a-alert v-else-if="flow.metadata.partial" type="warning" show-icon closable message="当前流程效率为部分数据，请结合数据质量状态判断。" />
          <div v-if="!flowSegmentLimitReached" class="orchestration-metrics__flow-summary">
            <div><span>流动效率</span><strong>{{ formatRate(flow.totals.flowEfficiency) }}</strong></div>
            <div><span>活跃时间</span><strong>{{ formatDuration(flow.totals.activeDurationMs) }}</strong></div>
            <div><span>人工等待</span><strong>{{ formatDuration(flow.totals.humanWaitDurationMs) }}</strong></div>
            <div><span>未分类</span><strong>{{ formatDuration(flow.totals.unclassifiedDurationMs) }}</strong></div>
          </div>
          <template v-if="!flowSegmentLimitReached && flowDurationDistributionRows.length">
            <h4 class="orchestration-metrics__subheading">闭合实例耗时分布</h4>
            <a-table size="small" :data-source="flowDurationDistributionRows" :pagination="false" row-key="key" :scroll="{ x: 720 }">
              <a-table-column title="分类" data-index="label" :width="120" />
              <a-table-column title="样本" :width="80"><template #default="{ record }">{{ record.distribution.sampleCount }}</template></a-table-column>
              <a-table-column title="P50" :width="100"><template #default="{ record }">{{ formatDuration(record.distribution.medianDurationMs) }}</template></a-table-column>
              <a-table-column title="P75" :width="100"><template #default="{ record }">{{ formatDuration(record.distribution.p75DurationMs) }}</template></a-table-column>
              <a-table-column title="P90" :width="100"><template #default="{ record }">{{ formatDuration(record.distribution.p90DurationMs) }}</template></a-table-column>
              <a-table-column title="P95" :width="100"><template #default="{ record }">{{ formatDuration(record.distribution.p95DurationMs) }}</template></a-table-column>
              <a-table-column title="均值" :width="100"><template #default="{ record }">{{ formatDuration(record.distribution.avgDurationMs) }}</template></a-table-column>
            </a-table>
          </template>
          <div v-if="!flowSegmentLimitReached && flowBarBreakdownItems.length" class="orchestration-metrics__flow-bar" aria-label="周期时间分解">
            <span
              v-for="item in flowBarBreakdownItems"
              :key="item.segmentType"
              :class="flowSegmentClass(item.segmentType)"
              :style="{ flexBasis: `${Math.max(0.6, (item.ratio ?? 0) * 100)}%` }"
              :title="`${item.label}: ${formatDuration(item.durationMs)} / ${formatRate(item.ratio)}`"
            />
          </div>
          <div v-if="!flowSegmentLimitReached" class="orchestration-metrics__flow-legend">
            <div v-for="item in flowBreakdownItems" :key="item.segmentType">
              <i :class="flowSegmentClass(item.segmentType)" />
              <strong>{{ item.label }}</strong>
              <a-tag v-if="item.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag>
              <template v-else><span>{{ formatDuration(item.durationMs) }}</span><span>{{ formatRate(item.ratio) }}</span></template>
            </div>
          </div>
          <a-table
            v-if="!flowSegmentLimitReached"
            size="small"
            :data-source="flow.items"
            :pagination="false"
            row-key="instanceId"
            :scroll="{ x: 1080 }"
          >
            <a-table-column title="任务" :width="250">
              <template #default="{ record }">
                <div class="orchestration-metrics__task-cell"><strong>{{ record.titleSummary || record.instanceId }}</strong><small>{{ record.workflowName }}</small></div>
              </template>
            </a-table-column>
            <a-table-column title="周期" :width="120"><template #default="{ record }">{{ formatDuration(record.wallClockDurationMs) }}</template></a-table-column>
            <a-table-column title="活跃" :width="120"><template #default="{ record }">{{ formatDuration(record.activeDurationMs) }}</template></a-table-column>
            <a-table-column title="人工等待" :width="120"><template #default="{ record }">{{ formatDuration(record.humanWaitDurationMs) }}</template></a-table-column>
            <a-table-column title="排队 / 暂停" :width="150"><template #default="{ record }">{{ formatDuration(record.queueDurationMs) }} / {{ formatDuration(record.pausedDurationMs) }}</template></a-table-column>
            <a-table-column title="未分类" :width="110"><template #default="{ record }">{{ formatDuration(record.unclassifiedDurationMs) }}</template></a-table-column>
            <a-table-column title="效率" :width="100"><template #default="{ record }"><strong>{{ formatRate(record.flowEfficiency) }}</strong></template></a-table-column>
            <a-table-column title="操作" :width="90" fixed="right">
              <template #default="{ record }">
                <a-tooltip :title="flowEvidenceTooltip(record)">
                  <a-button
                    type="link"
                    size="small"
                    :disabled="isSyntheticFlowItem(record)"
                    :loading="openingEvidenceInstanceId === record.instanceId"
                    @click="openFlowEvidence(record)"
                  >
                    <template #icon><EyeOutlined /></template>
                    查看
                  </a-button>
                </a-tooltip>
              </template>
            </a-table-column>
          </a-table>
          <div v-if="!flowSegmentLimitReached && flow.items.some((item) => item.actualPath.length)" class="orchestration-metrics__path-view">
            <div class="orchestration-metrics__section-head">
              <h3>实际执行路径与返工环</h3>
              <a-popover trigger="click" placement="bottomRight">
                <template #content><div class="orchestration-metrics__metric-definition"><strong>路径口径</strong><dl><div><dt>实际路径</dt><dd>按节点 execution 的实际开始或完成时间排序，不使用工作流定义推测。</dd></div><div><dt>返工环</dt><dd>同一节点出现多个 execution，或最大执行轮次大于 1。</dd></div></dl></div></template>
                <a-button type="text" size="small" aria-label="查看实际路径口径"><template #icon><InfoCircleOutlined /></template></a-button>
              </a-popover>
            </div>
            <div v-for="item in flow.items" :key="`path:${item.instanceId}`" class="orchestration-metrics__path-row">
              <div class="orchestration-metrics__task-cell"><strong>{{ item.titleSummary || item.instanceId }}</strong><small>{{ item.workflowName }}</small></div>
              <div class="orchestration-metrics__path-sequence">
                <template v-for="(node, index) in item.actualPath" :key="node.nodeExecutionId">
                  <span v-if="index" class="orchestration-metrics__path-arrow">→</span>
                  <span class="orchestration-metrics__path-node" :title="`${node.nodeExecutionId} · ${node.status}`">
                    {{ node.nodeLabel }}<small v-if="node.attemptNo > 1">第 {{ node.attemptNo }} 轮</small>
                  </span>
                </template>
                <span v-if="!item.actualPath.length" class="orchestration-metrics__muted">暂无节点执行事实</span>
              </div>
              <div class="orchestration-metrics__rework-tags">
                <a-tag v-for="loop in item.reworkLoops" :key="loop.nodeId" color="orange">
                  {{ loop.nodeLabel }}返工 {{ loop.executionCount }} 次
                </a-tag>
                <span v-if="!item.reworkLoops.length" class="orchestration-metrics__muted">无返工环</span>
              </div>
            </div>
          </div>
          <a-empty v-if="!flowSegmentLimitReached && !flow.items.length" :image="simpleEmptyImage" description="暂无可计算周期时间的实例" />
          <div v-if="flow.total > 0" class="orchestration-metrics__pagination">
            <span>{{ flow.items.length }} / {{ flow.total }}</span>
            <a-pagination
              size="small"
              :current="flow.page"
              :page-size="flow.pageSize"
              :total="flow.total"
              :show-size-changer="true"
              :page-size-options="['10', '20', '50', '100']"
              @change="handleFlowPageChange"
              @show-size-change="handleFlowPageChange"
            />
          </div>
        </template>
      </section>

      <section v-else-if="activeTab === 'conformance' && summary" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head"><h3>流程符合性</h3><div class="orchestration-metrics__section-actions"><span>逐节点对照冻结工作流</span><a-popover trigger="click" placement="bottomRight"><template #content><div class="orchestration-metrics__metric-definition"><strong>流程符合性口径</strong><dl><div><dt>符合率</dt><dd>严格符合节点数 ÷（严格符合节点数 + 流程偏离节点数）。</dd></div><div><dt>合法跳过</dt><dd>冻结工作流允许的条件分支未执行，不计为偏离。</dd></div><div><dt>人工覆盖</dt><dd>有明确人工授权的覆盖执行，单独展示且不计入严格符合率。</dd></div><div><dt>流程偏离</dt><dd>必需节点缺失、重复执行、非法分支或意外执行。</dd></div></dl></div></template><a-button type="text" size="small" aria-label="查看流程符合性口径"><template #icon><InfoCircleOutlined /></template></a-button></a-popover></div></div>
        <a-skeleton v-if="conformanceLoading && !conformance" active :paragraph="{ rows: 6 }" />
        <a-alert v-else-if="conformanceCompatibilityUnavailable" type="info" show-icon closable message="当前服务尚未提供流程符合性数据，请完成服务端升级后刷新快照。" />
        <a-alert v-else-if="conformanceError" type="error" show-icon :message="conformanceError" />
        <template v-else-if="conformance">
          <div class="orchestration-metrics__flow-summary">
            <div><span>符合率</span><strong>{{ formatRate(conformance.totals.conformanceRate) }}</strong></div>
            <div><span>流程偏离</span><strong>{{ conformance.totals.deviationCount }}</strong></div>
            <div><span>合法跳过</span><strong>{{ conformance.totals.legalSkipCount }}</strong></div>
            <div><span>人工覆盖</span><strong>{{ conformance.totals.manualOverrideCount }}</strong></div>
          </div>
          <a-alert v-if="conformance.metadata.partial" type="warning" show-icon closable message="当前符合性结论基于部分事实，请缩小查询范围或刷新数据后复核。" />
          <a-table :data-source="conformance.items" :pagination="false" row-key="sourceFingerprint" size="middle" :scroll="{ x: 980 }">
            <a-table-column title="节点" :width="220" fixed="left">
              <template #default="{ record }"><strong>{{ record.nodeLabel }}</strong><small>{{ record.instance.workflowName }}</small></template>
            </a-table-column>
            <a-table-column title="结论" :width="130">
              <template #default="{ record }"><a-tag :color="conformanceResultColor(record)">{{ conformanceResultLabel(record) }}</a-tag></template>
            </a-table-column>
            <a-table-column title="运行状态" data-index="observedStatus" :width="120" />
            <a-table-column title="执行次数" data-index="executionCount" :width="100" align="right" />
            <a-table-column title="分支" :width="180"><template #default="{ record }">{{ record.branchTaken || '-' }}</template></a-table-column>
            <a-table-column title="任务" :width="260"><template #default="{ record }">{{ record.instance.titleSummary }}</template></a-table-column>
            <a-table-column title="证据" :width="76" fixed="right" align="center">
              <template #default="{ record }"><a-button type="text" title="查看运行证据" @click="openConformanceEvidence(record)"><template #icon><EyeOutlined /></template></a-button></template>
            </a-table-column>
          </a-table>
          <a-empty v-if="!conformance.items.length" :image="simpleEmptyImage" description="当前范围暂无流程符合性事实" />
          <div v-if="conformance.total > 0" class="orchestration-metrics__pagination">
            <span>{{ conformance.items.length }} / {{ conformance.total }}</span>
            <a-pagination :current="conformance.page" :page-size="conformance.pageSize" :total="conformance.total" :show-size-changer="true" :page-size-options="['10', '20', '50', '100']" @change="handleConformancePageChange" @show-size-change="handleConformancePageChange" />
          </div>
        </template>
      </section>

      <section v-else-if="activeTab === 'specification' && summary" class="orchestration-metrics__deep-view">
        <template v-if="summary.specification">
        <div class="orchestration-metrics__section-head">
          <h3>结果规格质量</h3>
          <div class="orchestration-metrics__section-actions">
            <a-popover trigger="click" placement="bottomRight"><template #content><div class="orchestration-metrics__metric-definition"><strong>规格质量口径</strong><dl><div><dt>验证覆盖率</dt><dd>有验证结论的可评价终态实例 ÷ 全部可评价终态实例。</dd></div><div><dt>已覆盖样本成功率</dt><dd>验证通过实例 ÷ 已覆盖可评价终态实例；覆盖不完整时展示总体上下界，来源不完整时边界仅代表已记录终态。</dd></div><div><dt>已覆盖样本首次通过率</dt><dd>无重试、返工和审核驳回的验证通过实例 ÷ 已覆盖可评价终态实例。</dd></div><div><dt>契约覆盖</dt><dd>已评价必需契约 ÷ 全部必需契约。</dd></div><div><dt>已评价契约通过率</dt><dd>通过的必需契约 ÷ 已评价必需契约；覆盖不完整时展示总体上下界，来源不完整时不生成严格总体结论。</dd></div></dl></div></template><a-button type="text" size="small" aria-label="查看规格质量口径"><template #icon><InfoCircleOutlined /></template></a-button></a-popover>
            <a-button size="small" :disabled="!detailsAllowed" @click="openContractDetails">
              <template #icon><EyeOutlined /></template>
              契约明细
            </a-button>
            <a-tag :bordered="false" :color="summary.specification.validationCoverageRate === 1 && overview?.observedFirstPass?.populationStatus !== 'recorded_facts' && !summaryFactLimitReached ? 'success' : 'warning'">
              {{ summaryFactLimitReached ? '计算范围部分' : overview?.observedFirstPass?.populationStatus === 'recorded_facts' ? '来源覆盖不足' : summary.specification.validationCoverageRate === 1 ? '验证覆盖完整' : '验证覆盖不足' }}
            </a-tag>
          </div>
        </div>
        <div class="orchestration-metrics__validation">
          <div>
            <span>验证覆盖率</span>
            <strong>{{ formatRate(summary.specification.validationCoverageRate) }}</strong>
            <small>{{ summary.specification.validationCoveredTasks }} / {{ summary.specification.eligibleTasks }} 个可评价终态</small>
          </div>
          <div>
            <span>已验证样本成功率</span>
            <strong>{{ formatObservedRate(overview?.observedSuccess) }}</strong>
            <small>{{ formatObservedRateDetail(overview?.observedSuccess, summary.specification.validationCoverageRate, "已验证成功") }}</small>
          </div>
          <div>
            <span>已验证样本首次通过率</span>
            <strong>{{ formatObservedRate(overview?.observedFirstPass) }}</strong>
            <small>{{ formatObservedRateDetail(overview?.observedFirstPass, summary.specification.validationCoverageRate, "首次通过") }}</small>
          </div>
          <div>
            <span>可评价终态</span>
            <strong>{{ summary.specification.eligibleTasks }}</strong>
            <small>已排除取消实例</small>
          </div>
          <div>
            <span>重试影响实例</span>
            <strong>{{ summary.specification.retryAffectedTasks }}</strong>
            <small>存在 retry 的可评价终态</small>
          </div>
          <div>
            <span>返工影响实例</span>
            <strong>{{ summary.specification.reworkAffectedTasks }}</strong>
            <small>存在 rework 的可评价终态</small>
          </div>
          <div>
            <span>审核驳回实例</span>
            <strong>{{ summary.specification.rejectionAffectedTasks }}</strong>
            <small>存在 review rejection 的可评价终态</small>
          </div>
          <div>
            <span>契约证据覆盖率</span>
            <strong>{{ formatRate(summary.specification.contractEvidenceCoverageRate ?? null) }}</strong>
            <small>{{ summary.specification.evaluatedContractFacts ?? 0 }} / {{ summary.specification.requiredContractFacts ?? 0 }} 条必需契约</small>
          </div>
          <div>
            <span>已评价契约通过率</span>
            <strong>{{ formatObservedRate(overview?.observedContractPass) }}</strong>
            <small>{{ formatObservedRateDetail(overview?.observedContractPass, summary.specification.contractEvidenceCoverageRate, "契约通过", "契约") }}</small>
          </div>
          <div>
            <span>契约事实</span>
            <strong>{{ summary.specification.contractFacts ?? 0 }}</strong>
            <small>Gate、验收与 Artifact 证据</small>
          </div>
        </div>
        <div v-if="summary.specificationTrend.length" class="orchestration-metrics__spec-trend">
          <div class="orchestration-metrics__section-head">
            <h3>规格覆盖趋势</h3>
            <span>按契约评价时间统计必需项覆盖率</span>
          </div>
          <div class="orchestration-metrics__spec-trend-legend">
            <div v-for="category in specificationTrendCategories" :key="category.key">
              <i :style="{ background: category.color }" />
              <span>{{ category.label }}</span>
              <strong>{{ formatRate(latestSpecificationCoverage(category.key)) }}</strong>
            </div>
          </div>
          <svg class="orchestration-metrics__spec-trend-chart" viewBox="0 0 1000 180" preserveAspectRatio="none" role="img" aria-label="Gate、Artifact、验收标准和运行证据覆盖率趋势">
            <line x1="0" y1="20" x2="1000" y2="20" />
            <line x1="0" y1="90" x2="1000" y2="90" />
            <line x1="0" y1="160" x2="1000" y2="160" />
            <path v-for="category in specificationTrendCategories" :key="category.key" :d="specificationTrendPath(category.key)" :stroke="category.color" />
          </svg>
        </div>
        </template>
        <a-empty v-else description="当前服务尚未提供规格质量指标" />
      </section>

      <section v-else-if="activeTab === 'trend' && summary" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head">
          <h3>当前周期与历史周期</h3>
          <div class="orchestration-metrics__section-actions">
            <span>样本 {{ analysis?.metadata.sampleCount ?? 0 }}</span>
            <a-select
              v-model:value="filters.dimension"
              class="orchestration-metrics__analysis-dimension"
              :options="analysisDimensionOptions"
              :loading="analysisLoading"
              @change="loadAnalysisBreakdown"
            />
          </div>
        </div>
        <a-alert v-if="analysis?.metadata.partial" type="warning" show-icon closable message="当前结果包含缺失字段或小样本，请结合覆盖率判断。" />
        <h4 class="orchestration-metrics__subheading">时间趋势</h4>
        <div class="orchestration-metrics__comparison-table">
          <div v-for="bucket in analysis?.series ?? []" :key="bucket.key">
            <strong>{{ bucket.label }} <a-tag v-if="bucket.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag></strong><span>{{ bucket.current.totalTasks }} 次</span>
            <span>成功率 {{ formatVerifiedRate(bucket.current.successRate, bucket.current.validationCoverageRate) }}</span><span>耗时 P50 / P90 {{ formatDuration(bucket.current.medianDurationMs) }} / {{ formatDuration(bucket.current.p90DurationMs) }}</span>
            <i :class="{ 'is-negative': (bucket.delta.successRate ?? 0) < 0 }">较上期 {{ bucket.delta.successRate == null ? '-' : formatRate(bucket.delta.successRate) }}</i>
          </div>
        </div>
        <h4 class="orchestration-metrics__subheading">维度拆解</h4>
        <div class="orchestration-metrics__comparison-table">
          <div v-for="bucket in analysis?.breakdowns ?? []" :key="bucket.key">
            <strong>{{ bucket.label }} <a-tag v-if="bucket.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag></strong><span>{{ bucket.current.totalTasks }} 个实例</span>
            <span>成功率 {{ formatVerifiedRate(bucket.current.successRate, bucket.current.validationCoverageRate) }}</span><span>耗时 P50 / P90 {{ formatDuration(bucket.current.medianDurationMs) }} / {{ formatDuration(bucket.current.p90DurationMs) }}</span>
            <i :class="{ 'is-negative': (bucket.delta.successRate ?? 0) < 0 }">较上期 {{ bucket.delta.successRate == null ? '-' : formatRate(bucket.delta.successRate) }}</i>
          </div>
          <a-empty v-if="!(analysis?.breakdowns.length)" :image="simpleEmptyImage" description="当前维度暂无可拆解样本" />
        </div>
      </section>

      <section v-else-if="activeTab === 'bottleneck' && summary" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head"><h3>多信号节点异常</h3><span>同一流程版本内，六项信号完整且各至少 5 个样本后排名</span></div>
        <a-alert type="info" show-icon closable message="综合分用于发现异常线索，不代表节点直接导致交付问题。" />
        <div class="orchestration-metrics__rank-list">
          <div v-for="item in bottlenecks?.items ?? []" :key="item.key" class="orchestration-metrics__rank-row">
            <div class="orchestration-metrics__rank-head">
              <b>{{ item.rank == null ? '-' : `#${item.rank}` }}</b>
              <strong>{{ item.label }} <span>{{ item.workflowSnapshotHash === 'legacy' ? '历史版本未记录' : `版本 ${item.workflowSnapshotHash.slice(0, 8)} · 版本内排名` }}</span></strong>
              <span>最小有效样本 {{ item.sampleCount }}</span>
              <em :class="{ 'is-ranked': item.rankingStatus === 'ranked' }">{{ bottleneckRankingText(item) }}</em>
            </div>
            <a-alert v-if="item.privacy?.status === 'suppressed'" type="info" show-icon message="当前节点桶受小群体保护，仅保留版本、节点和样本量。" />
            <div v-else class="orchestration-metrics__bottleneck-components">
              <div v-for="component in bottleneckComponentRows(item)" :key="component.signal">
                <strong>{{ component.label }}</strong>
                <span>{{ component.valueText }}</span>
                <small>{{ component.detail }}</small>
                <a-progress v-if="component.riskPercent != null" :percent="component.riskPercent" :show-info="false" size="small" stroke-color="#c96442" />
                <a-tag v-else :color="component.status === 'missing_facts' ? 'orange' : 'default'">{{ component.statusText }}</a-tag>
              </div>
            </div>
          </div>
          <a-empty v-if="!(bottlenecks?.items.length)" :image="simpleEmptyImage" description="当前筛选范围暂无节点异常样本" />
        </div>
      </section>

      <section v-else-if="activeTab === 'correlation' && summary" class="orchestration-metrics__deep-view">
        <div class="orchestration-metrics__section-head">
          <h3>{{ correlationTitle }}</h3>
          <div class="orchestration-metrics__section-actions orchestration-metrics__correlation-selectors">
            <a-select
              v-model:value="correlationXMetric"
              data-testid="correlation-x-metric"
              aria-label="横轴指标"
              :options="correlationMetricOptions"
              :loading="correlationLoading"
            />
            <span>对</span>
            <a-select
              v-model:value="correlationYMetric"
              data-testid="correlation-y-metric"
              aria-label="纵轴指标"
              :options="correlationMetricOptions"
              :loading="correlationLoading"
            />
          </div>
        </div>
        <div class="orchestration-metrics__correlation-conclusion">
          <strong>当前结论</strong>
          <span>{{ correlationConclusion }}</span>
        </div>
        <div class="orchestration-metrics__correlation-summary">
          <div><span>线性相关 <small>Pearson</small></span><strong>{{ correlations?.pearson?.toFixed(2) ?? '-' }}</strong><em>{{ describeCorrelation(correlations?.pearson) }}</em></div>
          <div><span>排序相关 <small>Spearman</small></span><strong>{{ correlations?.spearman?.toFixed(2) ?? '-' }}</strong><em>{{ describeCorrelation(correlations?.spearman) }}</em></div>
          <div><span>有效样本</span><strong>{{ correlationSampleCount }}</strong><em>至少 20 个才计算</em></div>
        </div>
        <a-alert
          :type="correlationLoading ? 'info' : correlations?.pearson == null ? 'warning' : 'info'"
          show-icon
          closable
          :message="correlationLoading ? '正在加载所选指标' : correlations?.warning ?? '暂无关联样本'"
        />
        <div class="orchestration-metrics__correlation-method">
          <div><strong>比较什么</strong><span>横轴为{{ correlationXPresentation.label }}，纵轴为{{ correlationYPresentation.label }}。</span></div>
          <div><strong>怎么算</strong><span>Pearson 看线性变化，Spearman 看排序是否同向；系数范围为 -1 到 1，越接近 0 关联越弱。</span></div>
          <div><strong>怎么看图</strong><span>点整体向右上分布表示正相关，向右下表示负相关，分散无方向表示关联较弱。</span></div>
        </div>
        <div class="orchestration-metrics__scatter-wrap">
          <div class="orchestration-metrics__scatter-y-title">{{ correlationYAxisTitle }}</div>
          <div class="orchestration-metrics__scatter-y-max">{{ formatCorrelationMetricValue(responseCorrelationYMetric, scatterMaxY) }}</div>
          <div class="orchestration-metrics__scatter" :aria-label="`${correlationTitle}散点图`">
            <i v-for="point in scatterPoints" :key="point.key" :title="formatCorrelationPointTitle(point)" :style="{ left: `${point.left}%`, bottom: `${point.bottom}%` }" />
          </div>
          <div class="orchestration-metrics__scatter-origin">{{ formatCorrelationMetricValue(responseCorrelationXMetric, responseCorrelationXMetric === 'duration' ? 1 : 0) }}</div>
          <div class="orchestration-metrics__scatter-x-max">{{ formatCorrelationMetricValue(responseCorrelationXMetric, scatterMaxX) }}</div>
          <div class="orchestration-metrics__scatter-x-title">{{ correlationXAxisTitle }}</div>
        </div>
        <div class="orchestration-metrics__scatter-note">
          共读取 {{ correlationTotalSampleCount }} 个实例，排除 {{ correlationExcludedSampleCount }} 个不适用样本；图中显示 {{ scatterPointCount }} 个有效实例<span v-if="correlationSampleCount > scatterPointCount">，有效样本共 {{ correlationSampleCount }} 个，按二维分位稳定展示 80 个代表点</span>。点的位置分别对应{{ correlationXPresentation.label }}和{{ correlationYPresentation.label }}。
        </div>
      </section>

      <template v-if="activeTab === 'overview' && summary">
      <div class="orchestration-metrics__cards">
        <div
          v-for="card in overviewMetricCards"
          :key="card.key"
          class="orchestration-metrics__metric-card"
          :class="{ 'orchestration-metrics__metric-card--data-quality': card.key === 'data-quality' }"
        >
          <div class="orchestration-metrics__metric-card-head">
            <span>{{ card.label }}</span>
            <a-popover placement="bottomRight" trigger="click">
              <template #content>
                <div class="orchestration-metrics__metric-definition">
                  <strong>{{ card.definitionTitle || `${card.label}指标说明` }}</strong>
                  <p v-if="card.description" class="orchestration-metrics__metric-definition-summary">{{ card.description }}</p>
                  <dl>
                    <template v-if="card.key === 'data-quality'">
                      <div><dt>范围覆盖</dt><dd>授权来源全部采集成功，且查询未触及事实计算上限时为“完整”；存在采集失败、离线或截断时为“部分”；没有来源时为“不可用”。</dd></div>
                      <div><dt>必要证据</dt><dd>已采集实例具备必要时间、验证结果、原始 Trace 和可计算时长时为“完整”；证据缺失为“部分”，载荷损坏为“错误”。</dd></div>
                      <div><dt>数据时效</dt><dd>本轮完整刷新成功为“最新”；本轮未完整更新而包含最近可用结果时为“快照”；其他状态会明确显示刷新中、离线、异常或无数据。</dd></div>
                      <div><dt>事实一致</dt><dd>源载荷可解析且未发现已定义的事实冲突时为“有效”；状态区间冲突为“冲突”，载荷损坏为“错误”。</dd></div>
                      <div><dt>组合规则</dt><dd>“范围部分、证据完整”表示已采集记录完整，但授权范围没有全部更新。</dd></div>
                    </template>
                    <template v-else>
                      <div><dt>粒度</dt><dd>{{ metricGrainLabel(card.definition.grain) }}</dd></div>
                      <div><dt>分子</dt><dd>{{ card.definition.numerator }}</dd></div>
                      <div><dt>分母</dt><dd>{{ card.definition.denominator }}</dd></div>
                      <div><dt>样本规则</dt><dd>{{ card.definition.eligibilityRule }}</dd></div>
                      <div><dt>时间基准</dt><dd>{{ card.definition.timeBasis }}</dd></div>
                      <div><dt>必要事实</dt><dd>{{ card.definition.requiredFacts.map(metricFactLabel).join("、") }}</dd></div>
                      <div><dt>质量规则</dt><dd>{{ card.definition.qualityRule }}</dd></div>
                    </template>
                    <div><dt>最近观测</dt><dd>{{ formatDateTime(summary.observedAt) }}</dd></div>
                  </dl>
                </div>
              </template>
              <a-button type="text" size="small" class="orchestration-metrics__metric-info" :aria-label="`查看${card.label}定义`">
                <template #icon><InfoCircleOutlined /></template>
              </a-button>
            </a-popover>
          </div>
          <div
            v-if="card.key === 'data-quality' && dataQualityOverviewDimensions.length"
            class="orchestration-metrics__data-quality-dimensions"
            :title="card.value"
            :aria-label="card.value"
            role="group"
          >
            <span
              v-for="dimension in dataQualityOverviewDimensions"
              :key="dimension.key"
              class="orchestration-metrics__data-quality-dimension"
            >
              <small>{{ dimension.label }}</small>
              <strong>{{ dimension.value }}</strong>
            </span>
          </div>
          <strong v-else :title="card.value">{{ card.value }}</strong>
          <small v-if="card.detail">{{ card.detail }}</small>
        </div>
      </div>
      <div class="orchestration-metrics__grid">
        <section class="orchestration-metrics__section orchestration-metrics__section--trend">
          <div class="orchestration-metrics__section-head">
            <h3>执行趋势</h3>
            <div class="orchestration-metrics__trend-meta">
              <a-checkbox v-model:checked="showTrendTotal" @change="handleTrendSeriesToggle('total')"><span class="orchestration-metrics__trend-legend orchestration-metrics__trend-legend--total">总任务</span></a-checkbox>
              <a-checkbox v-model:checked="showTrendSuccess" :disabled="privacySuppressed" @change="handleTrendSeriesToggle('success')"><span class="orchestration-metrics__trend-legend orchestration-metrics__trend-legend--success">已验证成功</span></a-checkbox>
              <span>{{ trendBucketUnitLabel(summary.bucketUnit) }} · {{ trendTimezoneLabel(summary.filters.timezone) }}</span>
              <span>{{ formatDateTime(summary.freshness.refreshedAt) }}</span>
            </div>
          </div>
          <div v-if="trendChartPoints.length" class="orchestration-metrics__trend-chart" @mouseleave="hoveredTrendIndex = null">
            <div ref="trendCanvasElement" class="orchestration-metrics__trend-canvas">
            <svg :viewBox="`0 0 ${trendChartWidth} ${TREND_CHART.height}`" role="img" aria-label="执行趋势曲线图">
              <g v-for="tick in trendYAxisTicks" :key="tick.value">
                <line class="orchestration-metrics__trend-grid" :x1="TREND_CHART.left" :x2="trendChartWidth - TREND_CHART.right" :y1="tick.y" :y2="tick.y" />
                <text class="orchestration-metrics__trend-axis-label" :x="TREND_CHART.left - 10" :y="tick.y + 4" text-anchor="end">{{ tick.value }}</text>
              </g>
              <line class="orchestration-metrics__trend-axis" :x1="TREND_CHART.left" :x2="trendChartWidth - TREND_CHART.right" :y1="TREND_CHART.height - TREND_CHART.bottom" :y2="TREND_CHART.height - TREND_CHART.bottom" />
              <path v-if="showTrendTotal && trendChartPoints.length > 1" class="orchestration-metrics__trend-line orchestration-metrics__trend-line--total" :d="trendTotalPath" />
              <path v-if="showTrendSuccess && !privacySuppressed && trendChartPoints.length > 1" class="orchestration-metrics__trend-line orchestration-metrics__trend-line--success" :d="trendSuccessPath" />
              <g v-for="point in trendChartPoints" :key="point.bucket.bucketStart">
                <text v-if="point.showLabel" class="orchestration-metrics__trend-axis-label" :x="point.x" :y="TREND_CHART.height - 12" text-anchor="middle">{{ formatBucketLabel(point.bucket.bucketStart) }}</text>
                <circle v-if="showTrendTotal" class="orchestration-metrics__trend-point orchestration-metrics__trend-point--total" :class="{ 'is-active': hoveredTrendIndex === point.index }" :cx="point.x" :cy="point.yTotal" r="4" />
                <circle v-if="showTrendSuccess && !privacySuppressed && point.bucket.privacy?.status !== 'suppressed'" class="orchestration-metrics__trend-point orchestration-metrics__trend-point--success" :class="{ 'is-active': hoveredTrendIndex === point.index }" :cx="point.x" :cy="point.ySuccess" r="4" />
                <rect
                  class="orchestration-metrics__trend-hit"
                  :x="point.x - trendHitWidth / 2"
                  :y="TREND_CHART.top"
                  :width="trendHitWidth"
                  :height="TREND_CHART.height - TREND_CHART.top - TREND_CHART.bottom"
                  tabindex="0"
                  role="button"
                  :aria-label="trendBucketAriaLabel(point.bucket)"
                  @mouseenter="hoveredTrendIndex = point.index"
                  @focus="hoveredTrendIndex = point.index"
                  @blur="hoveredTrendIndex = null"
                  @click="hoveredTrendIndex = point.index"
                />
              </g>
              <line v-if="hoveredTrendPoint" class="orchestration-metrics__trend-crosshair" :x1="hoveredTrendPoint.x" :x2="hoveredTrendPoint.x" :y1="TREND_CHART.top" :y2="TREND_CHART.height - TREND_CHART.bottom" />
            </svg>
            <div
              v-if="hoveredTrendPoint"
              class="orchestration-metrics__trend-tooltip"
              :style="{ left: `${Math.min(91, Math.max(9, hoveredTrendPoint.x / trendChartWidth * 100))}%` }"
            >
              <strong>{{ formatBucketLabel(hoveredTrendPoint.bucket.bucketStart) }}</strong>
              <span><i class="orchestration-metrics__trend-dot orchestration-metrics__trend-dot--total" />总任务 {{ hoveredTrendPoint.bucket.totalTasks }}</span>
              <span><i class="orchestration-metrics__trend-dot orchestration-metrics__trend-dot--success" />已验证成功 {{ hoveredTrendPoint.bucket.successfulTasks ?? "受保护" }}</span>
              <span>可评价 {{ hoveredTrendPoint.bucket.eligibleTasks ?? "受保护" }} · 成功率 {{ formatVerifiedRate(hoveredTrendPoint.bucket.successRate, hoveredTrendPoint.bucket.eligibleTasks !== null && hoveredTrendPoint.bucket.eligibleTasks > 0 && hoveredTrendPoint.bucket.validationCoveredTasks !== null ? hoveredTrendPoint.bucket.validationCoveredTasks / hoveredTrendPoint.bucket.eligibleTasks : null) }}</span>
            </div>
            </div>
          </div>
          <a-empty v-else :image="simpleEmptyImage" description="当前范围暂无执行趋势" />
        </section>

        <div class="orchestration-metrics__overview-trends">
          <OrchestrationMetricLineChart
            title="Token 消耗趋势"
            :meta="`${overviewTrendMeta} · 按模型调用开始时间汇总`"
            aria-label="Token 消耗趋势曲线图"
            :series="overviewTokenTrendSeries"
            :points="overviewTokenTrendPoints"
            :loading="costsLoading"
            :error-message="costsError"
            empty-description="当前范围暂无 Token 消耗趋势"
          />
          <OrchestrationMetricLineChart
            title="代码贡献趋势"
            :meta="`${overviewTrendMeta} · 按代码提交观测时间汇总`"
            aria-label="代码贡献趋势曲线图"
            :series="overviewCodeTrendSeries"
            :points="overviewCodeTrendPoints"
            :loading="codeAttributionLoading"
            :error-message="codeAttributionError"
            empty-description="当前范围暂无代码贡献趋势"
          />
          <OrchestrationMetricLineChart
            title="规格覆盖趋势"
            :meta="`${overviewTrendMeta} · 按任务结果时间汇总`"
            aria-label="规格覆盖趋势曲线图"
            :series="overviewSpecificationTrendSeries"
            :points="overviewSpecificationTrendPoints"
            empty-description="当前范围暂无规格覆盖趋势"
          />
        </div>

        <section class="orchestration-metrics__section orchestration-metrics__section--overview-flow">
          <div class="orchestration-metrics__section-head">
            <div>
              <h3>流程时间构成</h3>
              <span class="orchestration-metrics__overview-flow-meta">按墙钟时间拆分已观测的活跃、等待、排队和暂停时间</span>
            </div>
            <div class="orchestration-metrics__section-actions">
              <span v-if="flow">流动效率 {{ formatRate(flow.totals.flowEfficiency) }}</span>
              <a-popover trigger="click" placement="bottomRight">
                <template #content><div class="orchestration-metrics__metric-definition"><strong>流程时间构成口径</strong><dl><div><dt>墙钟时间</dt><dd>实例启动到完成或最近观测时点的总时长。</dd></div><div><dt>活跃时间</dt><dd>Agent、工具、Artifact 写入和门禁检查区间去重后的时长。</dd></div><div><dt>流动效率</dt><dd>活跃时间 ÷ 墙钟时间。</dd></div><div><dt>未分类</dt><dd>没有可靠状态区间覆盖的剩余时间。</dd></div></dl></div></template>
                <a-button type="text" size="small" aria-label="查看流程时间构成口径"><template #icon><InfoCircleOutlined /></template></a-button>
              </a-popover>
            </div>
          </div>
          <a-skeleton v-if="flowLoading && !flow" active :paragraph="{ rows: 3 }" />
          <template v-else-if="flow">
            <a-alert v-if="flowSegmentLimitReached" type="error" show-icon closable message="状态区间过多，暂不展示流程时间构成，请缩小查询范围。" />
            <a-alert v-else-if="flow.metadata.dataQuality.consistency === 'conflicted'" type="error" show-icon closable message="状态区间存在冲突，流程时间构成暂不作为结论。" />
            <a-alert v-else-if="flow.metadata.partial" type="warning" show-icon closable message="流程时间构成为部分数据，请结合数据质量判断。" />
            <template v-if="!flowSegmentLimitReached && flow.metadata.dataQuality.consistency !== 'conflicted' && flowBarBreakdownItems.length">
              <div class="orchestration-metrics__flow-bar" aria-label="流程时间构成图">
                <span
                  v-for="item in flowBarBreakdownItems"
                  :key="`overview-${item.segmentType}`"
                  :class="flowSegmentClass(item.segmentType)"
                  :style="{ flexBasis: `${Math.max(0.6, (item.ratio ?? 0) * 100)}%` }"
                  :title="`${item.label}: ${formatDuration(item.durationMs)} / ${formatRate(item.ratio)}`"
                />
              </div>
              <div class="orchestration-metrics__flow-legend">
                <div v-for="item in flowBreakdownItems" :key="`overview-legend-${item.segmentType}`">
                  <i :class="flowSegmentClass(item.segmentType)" />
                  <strong>{{ item.label }}</strong>
                  <a-tag v-if="item.privacy?.status === 'suppressed'" :bordered="false">受保护</a-tag>
                  <template v-else><span>{{ formatDuration(item.durationMs) }}</span><span>{{ formatRate(item.ratio) }}</span></template>
                </div>
              </div>
            </template>
            <a-empty v-else :image="simpleEmptyImage" description="当前范围暂无可计算的流程时间构成" />
          </template>
          <a-empty v-else :image="simpleEmptyImage" description="当前范围暂无流程时间构成" />
        </section>

        <section class="orchestration-metrics__section">
          <div class="orchestration-metrics__section-head">
            <h3>验证概览</h3>
            <span>覆盖率 {{ formatRate(summary.validation.coverageRate) }}</span>
          </div>
          <div class="orchestration-metrics__validation">
            <div>
              <span>通过率</span>
              <strong>{{ formatRate(summary.validation.passRate) }}</strong>
            </div>
            <div>
              <span>已验证</span>
              <strong>{{ summary.validation.checkedCount }}</strong>
            </div>
            <div>
              <span>通过 / 失败</span>
              <strong>{{ summary.validation.passedCount }} / {{ summary.validation.failedCount }}</strong>
            </div>
            <div>
              <span>未评估任务</span>
              <strong>{{ summary.validation.notEvaluatedCount }}</strong>
            </div>
          </div>
        </section>
      </div>
      </template>
    </template>

    <a-modal v-model:open="evaluationScoreOpen" title="人工评分" :confirm-loading="evaluationScoreSaving" @ok="saveEvaluationScore">
      <a-form layout="vertical">
        <a-form-item label="结果">
          <a-radio-group v-model:value="evaluationScoreStatus">
            <a-radio-button value="passed">通过</a-radio-button>
            <a-radio-button value="failed">失败</a-radio-button>
            <a-radio-button value="missing_evidence">证据缺失</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="评分说明" required><a-textarea v-model:value="evaluationScoreExplanation" :maxlength="1000" :rows="4" show-count /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="improvementModalOpen"
      title="绑定候选并创建改进需求"
      ok-text="创建需求"
      cancel-text="取消"
      :confirm-loading="improvementCreating"
      :closable="!improvementCreating"
      :keyboard="!improvementCreating"
      :mask-closable="!improvementCreating"
      :cancel-button-props="{ disabled: improvementCreating }"
      :ok-button-props="{ disabled: improvementCandidatesLoading || !improvementCandidateCohortKey || !improvementWorkspaceId || !improvementHypothesis.trim() || !improvementTargetVersion.trim() || !improvementAcceptanceText.trim() || (improvementMode === 'link' && !improvementIntakeId) }"
      @ok="createImprovementIntake"
      @cancel="closeImprovementComposer"
    >
      <a-form layout="vertical">
        <a-form-item label="候选 Cohort" required>
          <a-select
            v-model:value="improvementCandidateCohortKey"
            :loading="improvementCandidatesLoading"
            :options="improvementCandidateOptions"
            placeholder="选择评估器和标准一致的候选配置"
            show-search
            option-filter-prop="label"
          />
          <div v-if="improvementCandidatesError" class="orchestration-metrics__form-error">{{ improvementCandidatesError }}</div>
        </a-form-item>
        <a-form-item label="处理方式" required>
          <a-radio-group v-model:value="improvementMode" button-style="solid" @change="() => loadImprovementIntakes()">
            <a-radio-button value="create">创建新需求</a-radio-button>
            <a-radio-button value="link">关联已有需求</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="目标工作区" required>
          <a-select
            v-model:value="improvementWorkspaceId"
            :options="improvementWorkspaceOptions"
            placeholder="选择保存改进需求的工作区"
            show-search
            option-filter-prop="label"
            @change="() => loadImprovementIntakes()"
          />
        </a-form-item>
        <a-form-item v-if="improvementMode === 'link'" label="已有需求" required>
          <a-select
            v-model:value="improvementIntakeId"
            :loading="improvementIntakesLoading"
            :options="improvementIntakes.map((item) => ({ label: item.title, value: String(item.id) }))"
            show-search
            :filter-option="false"
            placeholder="选择要关联的需求"
            @search="loadImprovementIntakes"
          />
          <div v-if="improvementIntakesError" class="orchestration-metrics__form-error">{{ improvementIntakesError }}</div>
        </a-form-item>
        <a-form-item label="待验证假设" required>
          <a-textarea v-model:value="improvementHypothesis" :maxlength="500" :rows="3" show-count placeholder="说明准备改变什么，以及预期改善哪个指标" />
        </a-form-item>
        <a-form-item label="目标配置" required>
          <a-input v-model:value="improvementTargetVersion" :maxlength="200" placeholder="例如新的流程、角色或 Prompt 配置" />
        </a-form-item>
        <a-form-item label="观察窗口" required>
          <a-select v-model:value="improvementObservationDays" :options="[{ label: '7 天', value: 7 }, { label: '14 天', value: 14 }, { label: '30 天', value: 30 }, { label: '60 天', value: 60 }, { label: '90 天', value: 90 }]" />
        </a-form-item>
        <a-form-item label="验收条件" required>
          <a-textarea v-model:value="improvementAcceptanceText" :maxlength="2000" :rows="4" show-count placeholder="每行一条可验证条件，例如：运行证据完整率不低于 95%" />
        </a-form-item>
        <a-descriptions v-if="improvementCohort" title="基线" size="small" :column="1" bordered>
          <a-descriptions-item label="评估标准">{{ evaluationCriterionLabel(improvementCohort.criterion) }}</a-descriptions-item>
          <a-descriptions-item label="引擎 / 模型 / 强度">{{ improvementCohort.engine }} / {{ improvementCohort.model || "未记录" }} / {{ improvementCohort.effort || "未记录" }}</a-descriptions-item>
          <a-descriptions-item label="Workflow / 节点">{{ shortSnapshotHash(improvementCohort.workflowSnapshotHash) }} / {{ improvementCohort.nodeId }}</a-descriptions-item>
          <a-descriptions-item label="Role / Prompt">{{ shortSnapshotHash(improvementCohort.roleSnapshotHash) }} / {{ shortSnapshotHash(improvementCohort.promptDefinitionHash) }}</a-descriptions-item>
          <a-descriptions-item label="创建时结论">{{ experimentConclusionLabel(improvementCohort.conclusion) }}</a-descriptions-item>
        </a-descriptions>
        <a-descriptions v-if="improvementCandidateCohort" title="候选" size="small" :column="1" bordered>
          <a-descriptions-item label="评估标准">{{ evaluationCriterionLabel(improvementCandidateCohort.criterion) }}</a-descriptions-item>
          <a-descriptions-item label="引擎 / 模型 / 强度">{{ improvementCandidateCohort.engine }} / {{ improvementCandidateCohort.model || "未记录" }} / {{ improvementCandidateCohort.effort || "未记录" }}</a-descriptions-item>
          <a-descriptions-item label="Workflow / 节点">{{ shortSnapshotHash(improvementCandidateCohort.workflowSnapshotHash) }} / {{ improvementCandidateCohort.nodeId }}</a-descriptions-item>
          <a-descriptions-item label="Role / Prompt">{{ shortSnapshotHash(improvementCandidateCohort.roleSnapshotHash) }} / {{ shortSnapshotHash(improvementCandidateCohort.promptDefinitionHash) }}</a-descriptions-item>
          <a-descriptions-item label="创建时结论">{{ experimentConclusionLabel(improvementCandidateCohort.conclusion) }}</a-descriptions-item>
        </a-descriptions>
      </a-form>
    </a-modal>

    <a-drawer
      :open="sourceHealthDrawerOpen"
      width="min(1120px, 96vw)"
      title="来源健康"
      placement="right"
      @close="closeSourceHealth"
    >
      <template #extra>
        <a-tooltip title="重新加载来源健康">
          <a-button type="text" aria-label="重新加载来源健康" :loading="sourceHealthLoading" @click="loadSourceHealth">
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-tooltip>
      </template>
      <a-alert v-if="sourceHealthError" type="error" show-icon :message="sourceHealthError" class="orchestration-metrics__evidence-alert">
        <template #action><a-button size="small" @click="loadSourceHealth">重试加载</a-button></template>
      </a-alert>
      <a-spin :spinning="sourceHealthLoading && !sourceHealth">
        <section class="orchestration-metrics__source-health-section">
          <div class="orchestration-metrics__section-head">
            <h3>来源状态</h3>
            <span>{{ sourceHealth?.sources.length ?? 0 }} 个工作区来源</span>
          </div>
          <a-table
            v-if="sourceHealth?.sources.length"
            :data-source="sourceHealth.sources"
            :pagination="false"
            row-key="sourceKey"
            size="small"
            :scroll="{ x: 1460, y: 340 }"
          >
            <a-table-column title="来源" :width="130" fixed="left">
              <template #default="{ record }"><code :title="record.sourceKey">{{ shortSourceKey(record.sourceKey) }}</code></template>
            </a-table-column>
            <a-table-column title="工作区" data-index="workspaceId" :ellipsis="true" :width="180" />
            <a-table-column title="在线" :width="80">
              <template #default="{ record }"><a-tag :bordered="false" :color="record.online ? 'green' : 'default'">{{ record.online ? "在线" : "离线" }}</a-tag></template>
            </a-table-column>
            <a-table-column title="版本" :width="190">
              <template #default="{ record }">schema {{ record.metricSchemaVersion ?? '-' }}<br /><small>{{ record.metricDefinitionVersion || '-' }}</small></template>
            </a-table-column>
            <a-table-column title="成功水位" :width="180">
              <template #default="{ record }">{{ formatDateTime(record.eventTimeWatermark) }}</template>
            </a-table-column>
            <a-table-column title="最近增量" :width="170">
              <template #default="{ record }">{{ formatDateTime(record.lastIncrementalAt) }}</template>
            </a-table-column>
            <a-table-column title="最近全量" :width="170">
              <template #default="{ record }">{{ formatDateTime(record.lastFullAt) }}</template>
            </a-table-column>
            <a-table-column title="最近结果" :width="230">
              <template #default="{ record }">
                <div class="orchestration-metrics__source-health-result">
                  <span><a-tag :bordered="false" :color="sourceHealthStatusColor(record.lastStatus)">{{ sourceHealthStatusLabel(record.lastStatus) }}</a-tag>{{ sourceCollectionModeLabel(record.lastMode) }}</span>
                  <small v-if="record.issueMessage">{{ record.issueMessage }}</small>
                </div>
              </template>
            </a-table-column>
            <a-table-column title="Request ID" :width="180">
              <template #default="{ record }"><code :title="record.requestId || ''">{{ record.requestId || '-' }}</code></template>
            </a-table-column>
            <a-table-column title="操作" :width="72" fixed="right" align="center">
              <template #default="{ record }">
                <a-tooltip :title="record.canRetry ? '定向重采该来源' : record.online ? '最近状态不需要重采' : '来源离线，暂时不能重采'">
                  <a-button
                    type="text"
                    aria-label="定向重采来源"
                    :disabled="!record.canRetry || Boolean(retryingSourceKey)"
                    :loading="retryingSourceKey === record.sourceKey"
                    @click="retryMetricSource(record)"
                  >
                    <template #icon><SyncOutlined /></template>
                  </a-button>
                </a-tooltip>
              </template>
            </a-table-column>
          </a-table>
          <a-empty v-else-if="!sourceHealthError" :image="simpleEmptyImage" description="当前范围没有来源运行记录" />
        </section>

        <section class="orchestration-metrics__source-health-section">
          <div class="orchestration-metrics__section-head">
            <h3>未对账交付批次</h3>
            <span>{{ sourceHealth?.unreconciledBatches.length ?? 0 }} 个批次</span>
          </div>
          <a-table
            v-if="sourceHealth?.unreconciledBatches.length"
            :data-source="sourceHealth.unreconciledBatches"
            :pagination="false"
            row-key="id"
            size="small"
            :scroll="{ x: 980, y: 240 }"
          >
            <a-table-column title="来源 / 批次" :width="240"><template #default="{ record }">{{ record.sourceSystem }} / {{ record.sourceBatchId }}</template></a-table-column>
            <a-table-column title="周期" :width="300"><template #default="{ record }">{{ formatDateTime(record.periodFrom) }} - {{ formatDateTime(record.periodTo) }}</template></a-table-column>
            <a-table-column title="记录数" :width="130"><template #default="{ record }">{{ record.acceptedRecordCount }} / {{ record.sourceRecordCount }}</template></a-table-column>
            <a-table-column title="原因" data-index="reasonMessage" :width="260" />
            <a-table-column title="操作" :width="130" fixed="right"><template #default><a-button type="link" size="small" @click="openDeliveryBatches">查看交付批次</a-button></template></a-table-column>
          </a-table>
          <a-empty v-else :image="simpleEmptyImage" description="当前范围没有未对账交付批次" />
        </section>
      </a-spin>
    </a-drawer>

    <a-drawer
      :open="nodeExecutionDrawerOpen"
      :width="760"
      :title="`${nodeExecutionLabel} · 执行轮次`"
      placement="right"
      @close="closeNodeExecutions"
    >
      <a-alert
        v-if="nodeExecutionWarning"
        type="warning"
        show-icon
        closable
        :message="nodeExecutionWarning"
        class="orchestration-metrics__evidence-alert"
      />
      <a-table
        v-if="nodeExecutionLoading || nodeExecutionRows.length"
        :data-source="nodeExecutionRows"
        :loading="nodeExecutionLoading"
        :pagination="false"
        row-key="nodeExecutionId"
        size="small"
        :scroll="{ x: 1040 }"
      >
        <a-table-column title="轮次" :width="72" fixed="left">
          <template #default="{ record }"><strong>#{{ record.attemptNo }}</strong></template>
        </a-table-column>
        <a-table-column title="状态" :width="110">
          <template #default="{ record }"><a-tag :bordered="false" :color="nodeExecutionStatusColor(record.status)">{{ record.status }}</a-tag></template>
        </a-table-column>
        <a-table-column title="任务" :width="210">
          <template #default="{ record }">
            <div class="orchestration-metrics__task-cell">
              <strong>{{ record.instance.titleSummary || record.instance.instanceId }}</strong>
              <small>{{ record.instance.workflowName }}</small>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="角色阶段" :width="140">
          <template #default="{ record }">{{ record.roleStageName || "-" }}</template>
        </a-table-column>
        <a-table-column title="耗时" :width="100" align="right">
          <template #default="{ record }">{{ formatDuration(record.durationMs) }}</template>
        </a-table-column>
        <a-table-column title="Execution ID" :width="180">
          <template #default="{ record }"><code :title="record.nodeExecutionId">{{ formatExecutionId(record.nodeExecutionId) }}</code></template>
        </a-table-column>
        <a-table-column title="父执行" :width="180">
          <template #default="{ record }"><code :title="record.parentExecutionId || ''">{{ formatExecutionId(record.parentExecutionId) }}</code></template>
        </a-table-column>
        <a-table-column title="证据" :width="72" fixed="right" align="center">
          <template #default="{ record }">
            <a-tooltip title="打开节点运行证据">
              <a-button
                type="text"
                size="small"
                :aria-label="`打开${record.nodeLabel}第${record.attemptNo}轮运行证据`"
                :loading="openingEvidenceInstanceId === record.instance.instanceId"
                @click="openNodeExecutionEvidence(record)"
              >
                <template #icon><EyeOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
        </a-table-column>
      </a-table>
      <a-empty v-else :image="simpleEmptyImage" description="暂无执行轮次" />
      <div v-if="nodeExecutionTotal > 0" class="orchestration-metrics__pagination orchestration-metrics__node-pagination">
        <span>共 {{ nodeExecutionTotal.toLocaleString("zh-CN") }} 个执行轮次</span>
        <a-pagination
          :current="nodeExecutionPage"
          :page-size="nodeExecutionPageSize"
          :total="nodeExecutionTotal"
          :page-size-options="['20', '50', '100']"
          show-size-changer
          size="small"
          @change="handleNodeExecutionPageChange"
          @show-size-change="handleNodeExecutionPageChange"
        />
      </div>
    </a-drawer>

    <a-drawer
      :open="contractDetailDrawerOpen"
      :width="980"
      title="规格契约明细"
      placement="right"
      @close="closeContractDetails"
    >
      <div class="orchestration-metrics__contract-filters">
        <a-select
          v-model:value="contractTypeFilter"
          :options="contractTypeOptions"
          aria-label="筛选契约类型"
          @change="handleContractDetailFilterChange"
        />
        <a-select
          v-model:value="contractStatusFilter"
          :options="contractStatusOptions"
          aria-label="筛选契约评价状态"
          @change="handleContractDetailFilterChange"
        />
        <span>共 {{ contractDetailTotal.toLocaleString("zh-CN") }} 条</span>
      </div>
      <a-alert v-if="contractDetailError" type="error" show-icon :message="contractDetailError" />
      <a-table
        v-if="contractDetailLoading || contractDetailRows.length"
        :data-source="contractDetailRows"
        :loading="contractDetailLoading"
        :pagination="false"
        :row-key="contractDetailRowKey"
        size="small"
        :scroll="{ x: 1600 }"
      >
        <a-table-column title="类型" :width="100" fixed="left">
          <template #default="{ record }"><strong>{{ contractTypeLabel(record.contractType) }}</strong></template>
        </a-table-column>
        <a-table-column title="状态" :width="108">
          <template #default="{ record }">
            <a-tag :bordered="false" :color="contractStatusColor(record.evaluationStatus)">{{ contractStatusLabel(record.evaluationStatus) }}</a-tag>
          </template>
        </a-table-column>
        <a-table-column title="要求" :width="72" align="center">
          <template #default="{ record }">{{ record.required ? "必需" : "可选" }}</template>
        </a-table-column>
        <a-table-column title="契约" :width="190">
          <template #default="{ record }">
            <div class="orchestration-metrics__contract-cell">
              <code :title="record.contractKey">{{ record.contractKey }}</code>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="任务" :width="210">
          <template #default="{ record }">
            <div class="orchestration-metrics__task-cell">
              <strong>{{ record.instance.titleSummary || record.instance.instanceId }}</strong>
              <small>{{ record.instance.workflowName }}</small>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="节点 / Execution" :width="190">
          <template #default="{ record }">
            <div class="orchestration-metrics__contract-cell">
              <span>{{ record.nodeId || "实例级" }}</span>
              <code :title="record.nodeExecutionId || ''">{{ formatExecutionId(record.nodeExecutionId) }}</code>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="证据" :width="240">
          <template #default="{ record }">
            <span class="orchestration-metrics__contract-evidence" :title="record.evidenceRef || ''">{{ record.evidenceRef || "-" }}</span>
          </template>
        </a-table-column>
        <a-table-column title="评价器" :width="170">
          <template #default="{ record }">
            <div class="orchestration-metrics__contract-cell">
              <span>{{ record.evaluatorId }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="评价时间" :width="156">
          <template #default="{ record }">{{ formatDateTime(record.evaluatedAt) }}</template>
        </a-table-column>
        <a-table-column title="证据详情" :width="78" fixed="right" align="center">
          <template #default="{ record }">
            <a-tooltip :title="canOpenArtifactDetails(record) ? '查看 Artifact 正文、文件和结构化字段' : '当前契约没有可定位的 Artifact 证据'">
              <a-button
                type="text"
                size="small"
                aria-label="打开 Artifact 证据详情"
                :disabled="!canOpenArtifactDetails(record)"
                :loading="openingArtifactId === resolveOrchestrationMetricArtifactId(record)"
                @click="openArtifactDetails(record)"
              >
                <template #icon><FileSearchOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
        </a-table-column>
        <a-table-column title="运行证据" :width="78" fixed="right" align="center">
          <template #default="{ record }">
            <a-tooltip title="打开实例或节点运行证据">
              <a-button
                type="text"
                size="small"
                aria-label="打开契约运行证据"
                :disabled="record.instance.instanceId.startsWith('metric-fixture-')"
                :loading="openingEvidenceInstanceId === record.instance.instanceId"
                @click="openContractEvidence(record)"
              >
                <template #icon><EyeOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
        </a-table-column>
      </a-table>
      <a-empty v-else-if="!contractDetailError" :image="simpleEmptyImage" description="当前筛选下暂无契约事实" />
      <div v-if="contractDetailTotal > 0" class="orchestration-metrics__pagination orchestration-metrics__node-pagination">
        <span>第 {{ contractDetailPage }} 页</span>
        <a-pagination
          :current="contractDetailPage"
          :page-size="contractDetailPageSize"
          :total="contractDetailTotal"
          :page-size-options="['20', '50', '100']"
          show-size-changer
          size="small"
          @change="handleContractDetailPageChange"
          @show-size-change="handleContractDetailPageChange"
        />
      </div>
    </a-drawer>

    <a-drawer
      v-model:open="artifactDetailDrawerOpen"
      title="Artifact 证据详情"
      width="min(1040px, 96vw)"
      :destroy-on-close="false"
      @after-open-change="handleArtifactDetailOpenChange"
    >
      <template #extra>
        <a-button type="primary" :disabled="!artifactDetailRecord" @click="openArtifactRuntimeEvidence">
          <template #icon><EyeOutlined /></template>
          运行证据
        </a-button>
      </template>
      <a-spin :spinning="artifactDetailLoading">
        <a-alert v-if="artifactDetailError" type="error" show-icon :message="artifactDetailError" />
        <template v-else-if="artifactDetail">
          <a-descriptions bordered size="small" :column="3" class="orchestration-metrics__artifact-summary">
            <a-descriptions-item label="标题" :span="2">{{ artifactDetail.title || artifactDetail.id }}</a-descriptions-item>
            <a-descriptions-item label="状态">
              <a-tag :bordered="false" :color="artifactStatusColor(artifactDetail.status)">{{ artifactDetail.status }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Artifact ID"><code>{{ artifactDetail.id }}</code></a-descriptions-item>
            <a-descriptions-item label="类型">{{ artifactDetail.kind }}</a-descriptions-item>
            <a-descriptions-item label="节点"><code>{{ artifactDetail.nodeId }}</code></a-descriptions-item>
            <a-descriptions-item label="持久化">{{ artifactDetail.persistenceMode || "-" }}</a-descriptions-item>
            <a-descriptions-item label="载荷模式">{{ artifactDetail.payloadMode || "-" }}</a-descriptions-item>
            <a-descriptions-item label="工作区状态">
              <a-tag :bordered="false" :color="artifactStatusColor(artifactDetail.workspaceStatus)">{{ artifactDetail.workspaceStatus || "-" }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="发布路径" :span="2"><code>{{ artifactDetail.publishedPath || artifactDetail.stagingPath || "-" }}</code></a-descriptions-item>
            <a-descriptions-item label="内容哈希"><code>{{ artifactDetail.contentHash || "-" }}</code></a-descriptions-item>
            <a-descriptions-item label="更新时间">{{ formatDateTime(artifactDetail.updatedAt) }}</a-descriptions-item>
            <a-descriptions-item label="契约评价">{{ contractStatusLabel(artifactDetailRecord?.evaluationStatus ?? "not_evaluated") }}</a-descriptions-item>
          </a-descriptions>

          <a-tabs class="orchestration-metrics__artifact-tabs">
            <a-tab-pane key="preview" tab="正文预览">
              <a-alert v-if="artifactContentError" type="error" show-icon :message="artifactContentError" class="orchestration-metrics__artifact-alert" />
              <a-select
                v-if="artifactPreviewOptions.length > 1"
                v-model:value="artifactPreviewPath"
                :options="artifactPreviewOptions"
                class="orchestration-metrics__artifact-preview-select"
              />
              <ArtifactFilePreview
                v-if="artifactDetailWorkspaceId && selectedArtifactPreview"
                :workspace-id="artifactDetailWorkspaceId"
                :preview="selectedArtifactPreview"
                empty-markdown-text="当前 Artifact 没有可预览正文"
              />
              <a-empty v-else description="当前 Artifact 没有可预览正文" />
            </a-tab-pane>
            <a-tab-pane key="files" :tab="`文件 (${artifactDetailFiles.length})`">
              <a-alert v-if="artifactFilesError" type="error" show-icon :message="artifactFilesError" class="orchestration-metrics__artifact-alert" />
              <a-table v-if="artifactDetailFiles.length" :data-source="artifactDetailFiles" :pagination="false" size="small" row-key="id" :scroll="{ x: 980 }">
                <a-table-column title="路径" data-index="relPath" :width="280" fixed="left" />
                <a-table-column title="角色" :width="100"><template #default="{ record }">{{ record.fileRole || "-" }}</template></a-table-column>
                <a-table-column title="格式" :width="100"><template #default="{ record }">{{ record.format || "-" }}</template></a-table-column>
                <a-table-column title="状态" :width="110"><template #default="{ record }"><a-tag :bordered="false" :color="artifactStatusColor(record.status)">{{ record.status }}</a-tag></template></a-table-column>
                <a-table-column title="校验" :width="110"><template #default="{ record }">{{ record.validationStatus || "-" }}</template></a-table-column>
                <a-table-column title="大小" :width="100" align="right"><template #default="{ record }">{{ formatArtifactSize(record.sizeBytes) }}</template></a-table-column>
                <a-table-column title="内容哈希" :width="240"><template #default="{ record }"><code>{{ record.contentHash }}</code></template></a-table-column>
              </a-table>
              <a-empty v-else-if="!artifactFilesError" description="当前 Artifact 没有文件索引" />
            </a-tab-pane>
            <a-tab-pane key="fields" :tab="`结构化字段 (${artifactDetailFields.length})`">
              <a-alert v-if="artifactFilesError" type="error" show-icon :message="artifactFilesError" class="orchestration-metrics__artifact-alert" />
              <a-table v-if="artifactDetailFields.length" :data-source="artifactDetailFields" :pagination="false" size="small" row-key="id" :scroll="{ x: 900 }">
                <a-table-column title="字段" :width="180" fixed="left"><template #default="{ record }"><strong>{{ record.label || record.fieldKey }}</strong><br><code>{{ record.fieldKey }}</code></template></a-table-column>
                <a-table-column title="结果" data-index="resultName" :width="150" />
                <a-table-column title="类型" data-index="valueType" :width="100" />
                <a-table-column title="要求" :width="80"><template #default="{ record }">{{ record.required ? "必需" : "可选" }}</template></a-table-column>
                <a-table-column title="来源" data-index="source" :width="90" />
                <a-table-column title="校验" :width="100"><template #default="{ record }"><a-tag :bordered="false" :color="artifactStatusColor(record.validationStatus)">{{ record.validationStatus }}</a-tag></template></a-table-column>
                <a-table-column title="值" :width="300"><template #default="{ record }"><span class="orchestration-metrics__artifact-field-value" :title="record.valueJson">{{ record.valuePreview || record.valueJson }}</span></template></a-table-column>
              </a-table>
              <a-empty v-else-if="!artifactFilesError" description="当前 Artifact 没有结构化字段" />
            </a-tab-pane>
            <a-tab-pane key="metadata" tab="元数据">
              <pre class="orchestration-metrics__artifact-metadata">{{ formatArtifactMetadata(artifactDetail) }}</pre>
            </a-tab-pane>
          </a-tabs>
        </template>
      </a-spin>
    </a-drawer>

    <a-drawer
      v-model:open="evidenceDrawerOpen"
      :title="evidenceDrawerTitle"
      width="min(1080px, 96vw)"
      :destroy-on-close="false"
    >
      <template #extra>
        <a-button type="primary" :disabled="!evidenceTarget" :loading="evidenceMonitorLoading" @click="openEvidenceRuntimeMonitor">
          <template #icon><EyeOutlined /></template>
          进入运行监控
        </a-button>
      </template>
      <a-spin :spinning="evidenceLoading">
        <a-alert v-if="evidenceError" type="error" show-icon :message="evidenceError" />
        <template v-else-if="evidenceData">
          <a-descriptions size="small" bordered :column="3" class="orchestration-metrics__evidence-status">
            <a-descriptions-item label="Prompt Snapshot">
              <a-tag :bordered="false" :color="evidenceStatusColor(evidenceData.status.promptSnapshot)">
                {{ evidenceStatusLabel(evidenceData.status.promptSnapshot) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Conversation Trace">
              <a-tag :bordered="false" :color="evidenceStatusColor(evidenceData.status.conversationTrace)">
                {{ evidenceStatusLabel(evidenceData.status.conversationTrace) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Raw Trace">
              <a-tag :bordered="false" :color="evidenceStatusColor(evidenceData.status.rawTrace)">
                {{ evidenceStatusLabel(evidenceData.status.rawTrace) }}
              </a-tag>
            </a-descriptions-item>
          </a-descriptions>
          <a-alert
            v-if="evidenceData.scopeStatus === 'incomplete'"
            type="warning"
            show-icon
            closable
            message="当前 execution 无法完整绑定 Prompt Snapshot、Thread 和 Turn，未使用整条线程数据代替轮次证据。"
            class="orchestration-metrics__evidence-alert"
          />
          <a-alert
            v-else-if="evidenceData.status.rawTrace === 'incomplete'"
            type="warning"
            show-icon
            closable
            message="已发现 conversation events，但 raw engine events 缺失；该执行存在原始轨迹证据缺口。"
            class="orchestration-metrics__evidence-alert"
          />
          <a-alert
            v-if="evidenceData.promptSnapshotsTruncated"
            type="info"
            show-icon
            closable
            :message="`Prompt Snapshot 目录仅展示最近 ${evidenceData.promptSnapshots.length} / ${evidenceData.promptSnapshotTotal} 条。`"
            class="orchestration-metrics__evidence-alert"
          />

          <section v-if="evidenceData.traceDetail" class="orchestration-metrics__evidence-section">
            <div class="orchestration-metrics__section-head">
              <h3>调用正文</h3>
              <span><code>{{ evidenceData.traceDetail.promptSnapshot.id }}</code></span>
            </div>
            <a-descriptions size="small" bordered :column="3">
              <a-descriptions-item label="节点 / 轮次">{{ evidenceData.traceDetail.promptSnapshot.nodeId }} · #{{ evidenceData.traceDetail.promptSnapshot.attemptNo }}</a-descriptions-item>
              <a-descriptions-item label="引擎 / 模型">{{ evidenceData.traceDetail.promptSnapshot.engine }} / {{ evidenceData.traceDetail.promptSnapshot.model || '-' }}</a-descriptions-item>
              <a-descriptions-item label="Turn 状态">{{ evidenceData.traceDetail.turn?.status || '无法绑定' }}</a-descriptions-item>
              <a-descriptions-item label="Thread"><code>{{ evidenceData.traceDetail.promptSnapshot.threadId || '-' }}</code></a-descriptions-item>
              <a-descriptions-item label="Turn"><code>{{ evidenceData.traceDetail.promptSnapshot.turnId || '-' }}</code></a-descriptions-item>
              <a-descriptions-item label="生成时间">{{ formatDateTime(evidenceData.traceDetail.promptSnapshot.createdAt) }}</a-descriptions-item>
            </a-descriptions>
            <a-tabs class="orchestration-metrics__trace-tabs">
              <a-tab-pane key="prompt" tab="Prompt">
                <div class="orchestration-metrics__trace-prompts">
                  <section><strong>System</strong><pre>{{ evidenceData.traceDetail.promptSnapshot.systemMessage || '未记录' }}</pre></section>
                  <section><strong>Developer</strong><pre>{{ evidenceData.traceDetail.promptSnapshot.developerMessage || '未记录' }}</pre></section>
                  <section><strong>User</strong><pre>{{ evidenceData.traceDetail.promptSnapshot.userMessage || '未记录' }}</pre></section>
                  <section><strong>Rendered input</strong><pre>{{ evidenceData.traceDetail.promptSnapshot.renderedInputPreview || '未记录' }}</pre></section>
                </div>
              </a-tab-pane>
              <a-tab-pane key="conversation" :tab="`Canonical (${evidenceData.traceDetail.conversationEvents.length}/${evidenceData.traceDetail.conversationEventCount})`">
                <a-alert
                  v-if="evidenceData.traceDetail.conversationEventsTruncated"
                  type="info"
                  show-icon
                  closable
                  :message="`当前只返回最近 ${evidenceData.traceDetail.conversationEvents.length} / ${evidenceData.traceDetail.conversationEventCount} 条 canonical 事件。`"
                  class="orchestration-metrics__evidence-alert"
                />
                <a-collapse v-if="evidenceData.traceDetail.conversationEvents.length" :bordered="false">
                  <a-collapse-panel v-for="event in evidenceData.traceDetail.conversationEvents" :key="event.seq" :header="conversationEvidenceLabel(event)">
                    <pre class="orchestration-metrics__trace-json">{{ formatEvidenceJson(event) }}</pre>
                  </a-collapse-panel>
                </a-collapse>
                <a-empty v-else :image="simpleEmptyImage" description="当前 Turn 没有 canonical 事件" />
              </a-tab-pane>
              <a-tab-pane key="raw" :tab="`Raw (${evidenceData.traceDetail.rawEngineEvents.length}/${evidenceData.traceDetail.rawEngineEventCount})`">
                <a-alert
                  v-if="evidenceData.traceDetail.rawEngineEventsTruncated"
                  type="info"
                  show-icon
                  closable
                  :message="`当前只返回最近 ${evidenceData.traceDetail.rawEngineEvents.length} / ${evidenceData.traceDetail.rawEngineEventCount} 条 raw 事件。`"
                  class="orchestration-metrics__evidence-alert"
                />
                <a-collapse v-if="evidenceData.traceDetail.rawEngineEvents.length" :bordered="false">
                  <a-collapse-panel v-for="event in evidenceData.traceDetail.rawEngineEvents" :key="event.seq" :header="rawEvidenceLabel(event)">
                    <pre class="orchestration-metrics__trace-json">{{ formatEvidenceJson(event) }}</pre>
                  </a-collapse-panel>
                </a-collapse>
                <a-empty v-else :image="simpleEmptyImage" description="当前 Turn 没有 raw 事件" />
              </a-tab-pane>
            </a-tabs>
          </section>

          <section class="orchestration-metrics__evidence-section">
            <div class="orchestration-metrics__section-head">
              <h3>Prompt Snapshot</h3>
              <span>{{ evidenceData.promptSnapshots.length }} / {{ evidenceData.promptSnapshotTotal }} 条</span>
            </div>
            <a-table
              v-if="evidenceData.promptSnapshots.length"
              :data-source="evidenceData.promptSnapshots"
              :pagination="false"
              row-key="id"
              size="small"
              :scroll="{ x: 760 }"
            >
              <a-table-column title="节点 / 轮次" :width="180"><template #default="{ record }">{{ record.nodeId }} · #{{ record.attemptNo }}</template></a-table-column>
              <a-table-column title="引擎 / 模型" :width="170"><template #default="{ record }">{{ record.engine }} / {{ record.model || '-' }}</template></a-table-column>
              <a-table-column title="Thread / Turn" :width="250"><template #default="{ record }"><code>{{ record.threadId || '-' }}</code><br /><code>{{ record.turnId || '-' }}</code></template></a-table-column>
              <a-table-column title="生成时间" :width="160"><template #default="{ record }">{{ formatDateTime(record.createdAt) }}</template></a-table-column>
            </a-table>
            <a-empty v-else :image="simpleEmptyImage" description="当前范围没有 Prompt Snapshot" />
          </section>

          <section class="orchestration-metrics__evidence-section">
            <div class="orchestration-metrics__section-head">
              <h3>线程证据</h3>
              <span>{{ evidenceData.threads.length }} 个线程</span>
            </div>
            <a-table
              v-if="evidenceData.threads.length"
              :data-source="evidenceData.threads"
              :pagination="false"
              row-key="threadId"
              size="small"
              :scroll="{ x: 980 }"
            >
              <a-table-column title="来源" :width="150"><template #default="{ record }">{{ evidenceThreadSources(record.sources) }}</template></a-table-column>
              <a-table-column title="Thread" :width="220"><template #default="{ record }"><code>{{ record.threadId }}</code></template></a-table-column>
              <a-table-column title="Conversation" :width="120" align="right"><template #default="{ record }">{{ record.conversationEventCount }}</template></a-table-column>
              <a-table-column title="Raw" :width="90" align="right"><template #default="{ record }">{{ record.rawEngineEventCount }}</template></a-table-column>
              <a-table-column title="Turns" :width="90" align="right"><template #default="{ record }">{{ record.turnCount }}</template></a-table-column>
              <a-table-column title="最近定位引用" :width="300">
                <template #default="{ record }">
                  <div class="orchestration-metrics__evidence-refs">
                    <span v-for="turn in record.latestTurns.slice(0, 2)" :key="`t-${turn.turnId}`">T {{ turn.turnId }} · {{ turn.status }}</span>
                    <span v-for="event in record.latestConversationEvents.slice(0, 3)" :key="`c-${event.seq}`">C#{{ event.seq }} {{ event.kind }}</span>
                    <span v-for="event in record.latestRawEngineEvents.slice(0, 3)" :key="`r-${event.seq}`">R#{{ event.seq }} {{ event.kind }}</span>
                    <span v-if="!record.latestTurns.length && !record.latestConversationEvents.length && !record.latestRawEngineEvents.length">-</span>
                  </div>
                </template>
              </a-table-column>
            </a-table>
            <a-empty v-else :image="simpleEmptyImage" description="当前范围没有可定位线程" />
          </section>
        </template>
      </a-spin>
    </a-drawer>
  </div>
</template>

<style scoped>
.orchestration-metrics {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: auto;
}

.orchestration-metrics__initial-loading {
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  color: var(--app-muted);
}

.orchestration-metrics__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, #f4f6f8);
}

.orchestration-metrics__toolbar-fields,
.orchestration-metrics__toolbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}

.orchestration-metrics__toolbar-fields {
  flex: 1 1 auto;
}

.orchestration-metrics__toolbar-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  white-space: nowrap;
}

.orchestration-metrics__action-help {
  width: min(340px, calc(100vw - 48px));
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.65;
}

.orchestration-metrics__action-help p {
  margin: 0;
}

.orchestration-metrics__action-help p + p {
  margin-top: 8px;
}

.orchestration-metrics__source-health-section {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding-bottom: 18px;
}

.orchestration-metrics__source-health-section + .orchestration-metrics__source-health-section {
  padding-top: 18px;
  border-top: 1px solid var(--app-border);
}

.orchestration-metrics__source-health-section code {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.orchestration-metrics__source-health-result {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.orchestration-metrics__source-health-result > span {
  display: flex;
  align-items: center;
  gap: 6px;
}

.orchestration-metrics__source-health-result small {
  color: var(--app-muted);
  line-height: 1.4;
}

.orchestration-metrics__field {
  width: 118px;
  min-width: 0;
  flex: 0 1 118px;
}

.orchestration-metrics__field--scope {
  width: 126px;
  flex-basis: 126px;
}

.orchestration-metrics__field--candidate {
  width: 176px;
  flex-basis: 176px;
}

.orchestration-metrics__field--wide {
  width: 146px;
  min-width: 0;
  flex-basis: 146px;
}

.orchestration-metrics__query-button {
  flex: 0 0 auto;
  white-space: nowrap;
}

.orchestration-metrics__freshness--fresh {
  background: color-mix(in srgb, #16a34a 14%, var(--app-panel-bg, #fff));
  color: #15803d;
}

.orchestration-metrics__freshness--offline,
.orchestration-metrics__freshness--stale,
.orchestration-metrics__freshness--generating {
  background: color-mix(in srgb, #f59e0b 14%, var(--app-panel-bg, #fff));
  color: #a16207;
}

.orchestration-metrics__freshness--error {
  background: color-mix(in srgb, #dc2626 12%, var(--app-panel-bg, #fff));
  color: #b91c1c;
}

.orchestration-metrics__freshness-time {
  color: var(--app-muted);
  font-size: 12px;
  white-space: nowrap;
}

.orchestration-metrics__cards {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-border);
}

.orchestration-metrics__metric-card {
  display: grid;
  align-content: center;
  gap: 2px;
  min-height: 64px;
  min-width: 0;
  padding: 8px 12px;
  background: var(--app-panel-bg);
}

.orchestration-metrics__metric-card span,
.orchestration-metrics__metric-card small,
.orchestration-metrics__section-head span,
.orchestration-metrics__node-title small,
.orchestration-metrics__pagination,
.orchestration-metrics__task-cell small {
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__metric-card strong {
  min-width: 0;
  color: var(--app-text);
  font-size: 18px;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.orchestration-metrics__metric-card--data-quality strong {
  font-size: 17px;
  white-space: nowrap;
}

.orchestration-metrics__data-quality-dimensions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  min-width: 0;
}

.orchestration-metrics__data-quality-dimension {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: 0 5px;
}

.orchestration-metrics__data-quality-dimension:first-child {
  padding-left: 0;
}

.orchestration-metrics__data-quality-dimension + .orchestration-metrics__data-quality-dimension {
  border-left: 1px solid var(--app-border);
}

.orchestration-metrics__metric-card--data-quality .orchestration-metrics__data-quality-dimension small {
  font-size: 10px;
  line-height: 1.1;
  white-space: nowrap;
}

.orchestration-metrics__metric-card--data-quality .orchestration-metrics__data-quality-dimension strong {
  font-size: 12px;
  line-height: 1.15;
  white-space: nowrap;
}

.orchestration-metrics__metric-card span,
.orchestration-metrics__metric-card small {
  line-height: 1.35;
}

.orchestration-metrics__metric-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.orchestration-metrics__metric-info {
  width: 20px;
  min-width: 20px;
  height: 20px;
  padding: 0;
  color: var(--app-muted);
}

.orchestration-metrics__metric-definition {
  display: grid;
  gap: 10px;
  width: min(420px, calc(100vw - 48px));
}

.orchestration-metrics__metric-definition > strong {
  color: var(--app-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.orchestration-metrics__metric-definition-summary {
  margin: 0;
  color: var(--app-text);
  line-height: 1.6;
}

.orchestration-metrics__metric-definition dl {
  display: grid;
  gap: 8px;
  margin: 0;
}

.orchestration-metrics__metric-definition dl > div {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 8px;
}

.orchestration-metrics__metric-definition dt {
  color: var(--app-muted);
}

.orchestration-metrics__metric-definition dd {
  min-width: 0;
  margin: 0;
  color: var(--app-text);
  overflow-wrap: anywhere;
}

.orchestration-metrics__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  gap: 12px;
}

.orchestration-metrics__section {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.orchestration-metrics__section--trend,
.orchestration-metrics__section--details {
  grid-column: 1 / -1;
}

.orchestration-metrics__overview-trends {
  display: grid;
  grid-column: 1 / -1;
  gap: 12px;
  min-width: 0;
}

.orchestration-metrics__section--overview-flow {
  grid-column: 1 / -1;
}

.orchestration-metrics__overview-flow-meta {
  display: block;
  margin-top: 3px;
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.orchestration-metrics__section-head h3 {
  margin: 0;
  color: var(--app-text);
  font-size: 15px;
  font-weight: 700;
}

.orchestration-metrics__section-actions,
.orchestration-metrics__contract-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.orchestration-metrics__analysis-dimension {
  width: 136px;
}

.orchestration-metrics__subheading {
  margin: 16px 0 8px;
  color: var(--app-text);
  font-size: 13px;
  font-weight: 700;
}

.orchestration-metrics__contract-filters {
  margin-bottom: 12px;
}

.orchestration-metrics__contract-filters :deep(.ant-select) {
  width: 150px;
}

.orchestration-metrics__contract-filters > span {
  margin-left: auto;
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__contract-cell {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.orchestration-metrics__contract-cell code,
.orchestration-metrics__contract-cell span,
.orchestration-metrics__contract-cell small,
.orchestration-metrics__contract-evidence {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.orchestration-metrics__contract-cell small {
  color: var(--app-muted);
  font-size: 11px;
}

.orchestration-metrics__contract-evidence {
  display: block;
  max-width: 220px;
}

.orchestration-metrics__artifact-summary {
  margin-bottom: 12px;
}

.orchestration-metrics__artifact-tabs {
  min-width: 0;
}

.orchestration-metrics__artifact-alert {
  margin-bottom: 12px;
}

.orchestration-metrics__artifact-preview-select {
  width: min(520px, 100%);
  margin-bottom: 12px;
}

.orchestration-metrics__artifact-field-value {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.orchestration-metrics__artifact-metadata {
  max-height: 520px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-muted-bg, color-mix(in srgb, var(--app-border) 24%, transparent));
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.orchestration-metrics__trend-meta,
.orchestration-metrics__trend-legend {
  display: inline-flex;
  align-items: center;
}

.orchestration-metrics__trend-meta {
  gap: 14px;
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__trend-legend {
  gap: 5px;
}

.orchestration-metrics__trend-legend::before {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  content: "";
}

.orchestration-metrics__trend-legend--total::before {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #38bdf8);
}

.orchestration-metrics__trend-legend--success::before {
  background: #16a34a;
  opacity: 0.82;
}

.orchestration-metrics__trend-chart {
  position: relative;
  min-width: 0;
  overflow-x: auto;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
}

.orchestration-metrics__trend-canvas {
  position: relative;
  min-width: 640px;
}

.orchestration-metrics__trend-canvas svg {
  display: block;
  width: 100%;
  height: 260px;
  overflow: visible;
}

.orchestration-metrics__trend-grid {
  stroke: color-mix(in srgb, var(--app-border) 72%, transparent);
  stroke-dasharray: 4 5;
  stroke-width: 1;
}

.orchestration-metrics__trend-axis {
  stroke: var(--app-border);
  stroke-width: 1;
}

.orchestration-metrics__trend-axis-label {
  fill: var(--app-muted);
  font-size: 11px;
}

.orchestration-metrics__trend-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 3;
  pointer-events: none;
}

.orchestration-metrics__trend-line--total,
.orchestration-metrics__trend-point--total {
  stroke: #1677ff;
}

.orchestration-metrics__trend-line--success,
.orchestration-metrics__trend-point--success {
  stroke: #16a34a;
}

.orchestration-metrics__trend-point {
  fill: var(--app-panel-bg);
  stroke-width: 2;
  pointer-events: none;
  transition: r 120ms ease, stroke-width 120ms ease;
}

.orchestration-metrics__trend-point.is-active {
  r: 6px;
  stroke-width: 3;
}

.orchestration-metrics__trend-hit {
  fill: transparent;
  cursor: crosshair;
  outline: none;
}

.orchestration-metrics__trend-hit:focus {
  fill: color-mix(in srgb, var(--app-primary, #1677ff) 5%, transparent);
}

.orchestration-metrics__trend-crosshair {
  stroke: color-mix(in srgb, var(--app-text) 42%, transparent);
  stroke-dasharray: 3 4;
  stroke-width: 1;
  pointer-events: none;
}

.orchestration-metrics__trend-tooltip {
  position: absolute;
  top: 24px;
  z-index: 3;
  display: grid;
  gap: 6px;
  min-width: 184px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel-bg);
  box-shadow: 0 8px 22px rgb(15 23 42 / 14%);
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.45;
  pointer-events: none;
  transform: translateX(-50%);
}

.orchestration-metrics__trend-tooltip strong {
  font-size: 13px;
}

.orchestration-metrics__trend-tooltip span {
  display: flex;
  align-items: center;
  gap: 6px;
}

.orchestration-metrics__trend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.orchestration-metrics__trend-dot--total { background: #1677ff; }
.orchestration-metrics__trend-dot--success { background: #16a34a; }

.orchestration-metrics__trend-meta :deep(.ant-checkbox-wrapper) {
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__node-list,
.orchestration-metrics__quality-list {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.orchestration-metrics__node-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(100px, 1.2fr) minmax(220px, auto) 32px;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.orchestration-metrics__stage-duration {
  display: grid;
  gap: 2px;
  min-width: 0;
  text-align: right;
}

.orchestration-metrics__stage-duration small {
  color: var(--app-muted);
  font-size: 11px;
}

.orchestration-metrics__node-action {
  width: 28px;
  height: 28px;
}

.orchestration-metrics__node-pagination {
  margin-top: 16px;
}

.orchestration-metrics__evidence-status,
.orchestration-metrics__evidence-alert {
  margin-bottom: 16px;
}

.orchestration-metrics__evidence-section {
  display: grid;
  gap: 10px;
  padding: 14px 0;
  border-top: 1px solid var(--app-border);
}

.orchestration-metrics__evidence-refs {
  display: grid;
  gap: 3px;
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__trace-tabs {
  min-width: 0;
}

.orchestration-metrics__trace-prompts {
  display: grid;
  gap: 12px;
}

.orchestration-metrics__trace-prompts section {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.orchestration-metrics__trace-prompts strong {
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__trace-prompts pre,
.orchestration-metrics__trace-json {
  max-height: 420px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-muted-bg, color-mix(in srgb, var(--app-border) 24%, transparent));
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.orchestration-metrics__node-title {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.orchestration-metrics__node-title strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text);
  font-size: 13px;
}

.orchestration-metrics__node-bar,
.orchestration-metrics__quality-row div {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 55%, transparent);
}

.orchestration-metrics__node-bar span,
.orchestration-metrics__quality-row i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 78%, #38bdf8);
}

.orchestration-metrics__node-row code,
.orchestration-metrics__task-cell code,
.orchestration-metrics :deep(code) {
  font-family: var(--app-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
}

.orchestration-metrics__quality-row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) 42px;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.orchestration-metrics__quality-row span,
.orchestration-metrics__quality-row strong {
  font-size: 12px;
  color: var(--app-text);
}

.orchestration-metrics__validation {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.orchestration-metrics__validation div {
  display: grid;
  gap: 4px;
  min-height: 66px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, #f8fafc);
}

.orchestration-metrics__validation span {
  color: var(--app-muted);
  font-size: 12px;
}

.orchestration-metrics__validation strong {
  color: var(--app-text);
  font-size: 18px;
}

.orchestration-metrics__validation .orchestration-metrics__validation-text {
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
}

.orchestration-metrics__task-cell {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.orchestration-metrics__task-cell strong,
.orchestration-metrics__task-cell small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.orchestration-metrics__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.orchestration-metrics__tabs { margin-top: 2px; }
.orchestration-metrics__tabs :deep(.ant-tabs-nav) { margin-bottom: 0; }
.orchestration-metrics__mobile-view-select { display: none; }
.orchestration-metrics__export-status { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 0; border-bottom: 1px solid var(--app-border); color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__export-error { color: #b91c1c; }
.orchestration-metrics__form-error { margin-top: 6px; color: #b91c1c; font-size: 12px; }
.orchestration-metrics__deep-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; padding: 18px 0 24px; }
.orchestration-metrics__deep-view :deep(.ant-alert-message) { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.orchestration-metrics__deep-view--delivery { gap: 10px; padding: 12px 0 18px; }
.orchestration-metrics__flow-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--app-border); border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__flow-summary > div { display: grid; gap: 5px; min-width: 0; padding: 14px; }
.orchestration-metrics__flow-summary > div + div { border-left: 1px solid var(--app-border); }
.orchestration-metrics__flow-summary span { color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__flow-summary strong { overflow-wrap: anywhere; font-size: 22px; }
.orchestration-metrics__flow-summary--delivery { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.orchestration-metrics__flow-summary--delivery > div { gap: 2px; padding: 9px 12px; }
.orchestration-metrics__flow-summary--delivery strong { font-size: 20px; line-height: 1.2; }
.orchestration-metrics__flow-summary--delivery small { color: var(--app-muted); font-size: 12px; line-height: 1.3; }
.orchestration-metrics__cohort-reasons { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__experiment-filters { display: grid; grid-template-columns: minmax(220px, 320px) 180px; gap: 8px; }
.orchestration-metrics__experiment-filters > * { min-width: 0; }
.orchestration-metrics__evaluation-toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) 130px 190px 96px auto; gap: 8px; align-items: center; margin-bottom: 12px; }
.orchestration-metrics__evaluation-toolbar > * { min-width: 0; }
.orchestration-metrics__cohort-table { width: 100%; max-width: 100%; min-width: 0; overflow: hidden; }
.orchestration-metrics__cohort-row--focused > td { background: color-mix(in srgb, var(--app-primary, #1677ff) 9%, var(--app-panel-bg, #fff)) !important; }
.orchestration-metrics__cohort-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; margin: 0; }
.orchestration-metrics__cohort-details > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px; min-width: 0; }
.orchestration-metrics__cohort-details dt { color: var(--app-muted); }
.orchestration-metrics__cohort-details dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.orchestration-metrics__flow-bar { display: flex; width: 100%; height: 16px; overflow: hidden; border: 1px solid var(--app-border); border-radius: 4px; background: color-mix(in srgb, var(--app-border) 28%, transparent); }
.orchestration-metrics__flow-bar > span { min-width: 4px; }
.orchestration-metrics__flow-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid var(--app-border); }
.orchestration-metrics__flow-legend > div { display: grid; grid-template-columns: 12px minmax(90px, 1fr) auto 64px; gap: 8px; align-items: center; min-height: 42px; padding: 8px 4px; border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__flow-legend > div:nth-child(odd) { padding-right: 16px; }
.orchestration-metrics__flow-legend > div:nth-child(even) { padding-left: 16px; border-left: 1px solid var(--app-border); }
.orchestration-metrics__flow-legend i { width: 10px; height: 10px; border-radius: 2px; }
.orchestration-metrics__flow-legend strong { min-width: 0; font-size: 12px; }
.orchestration-metrics__flow-legend span { color: var(--app-muted); font-size: 12px; text-align: right; }
.orchestration-metrics__path-view { display: grid; gap: 0; margin-top: 18px; border-top: 1px solid var(--app-border); }
.orchestration-metrics__path-view > .orchestration-metrics__section-head { padding: 12px 0; border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__path-row { display: grid; grid-template-columns: minmax(160px, 220px) minmax(320px, 1fr) minmax(160px, 260px); gap: 12px; align-items: center; min-height: 58px; padding: 8px 0; border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__path-sequence { display: flex; gap: 6px; align-items: center; min-width: 0; overflow-x: auto; padding: 3px 0; }
.orchestration-metrics__path-node { display: inline-flex; flex: 0 0 auto; gap: 4px; align-items: baseline; padding: 4px 7px; border: 1px solid var(--app-border); border-radius: 4px; background: var(--app-surface); font-size: 12px; }
.orchestration-metrics__path-node small, .orchestration-metrics__path-arrow, .orchestration-metrics__muted { color: var(--app-muted); font-size: 11px; }
.orchestration-metrics__rework-tags { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.orchestration-metrics__spec-trend { display: grid; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--app-border); }
.orchestration-metrics__spec-trend > .orchestration-metrics__section-head > span { color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__spec-trend-legend { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.orchestration-metrics__spec-trend-legend > div { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 6px; align-items: center; min-width: 0; font-size: 12px; }
.orchestration-metrics__spec-trend-legend i { width: 8px; height: 8px; border-radius: 2px; }
.orchestration-metrics__spec-trend-legend span { overflow: hidden; color: var(--app-muted); text-overflow: ellipsis; white-space: nowrap; }
.orchestration-metrics__spec-trend-chart { display: block; width: 100%; height: 220px; overflow: visible; }
.orchestration-metrics__spec-trend-chart line { stroke: var(--app-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.orchestration-metrics__spec-trend-chart path { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.orchestration-metrics__flow-segment--paused { background: #64748b; }
.orchestration-metrics__flow-segment--waiting-start { background: #d97706; }
.orchestration-metrics__flow-segment--waiting-approval { background: #dc2626; }
.orchestration-metrics__flow-segment--waiting-feedback { background: #ca8a04; }
.orchestration-metrics__flow-segment--queue { background: #2563eb; }
.orchestration-metrics__flow-segment--tool-active { background: #0f766e; }
.orchestration-metrics__flow-segment--gate-checking { background: #7c3aed; }
.orchestration-metrics__flow-segment--artifact-writing { background: #0891b2; }
.orchestration-metrics__flow-segment--agent-active { background: #15803d; }
.orchestration-metrics__flow-segment--unclassified { background: #94a3b8; }
.orchestration-metrics__comparison-table { display: grid; border-top: 1px solid var(--app-border); }
.orchestration-metrics__comparison-table > div { display: grid; grid-template-columns: minmax(150px, 1.4fr) repeat(4, minmax(100px, 1fr)); gap: 12px; align-items: center; min-height: 58px; padding: 10px 4px; border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__comparison-table span, .orchestration-metrics__comparison-table i { color: var(--app-muted); font-size: 12px; font-style: normal; }
.orchestration-metrics__comparison-table i { color: #047857; }
.orchestration-metrics__comparison-table i.is-negative { color: #b91c1c; }
.orchestration-metrics__rank-list { display: grid; }
.orchestration-metrics__rank-row { display: grid; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__rank-head { display: grid; grid-template-columns: 46px minmax(180px, 1fr) 130px 180px; gap: 12px; align-items: center; min-width: 0; }
.orchestration-metrics__rank-head > strong { min-width: 0; }
.orchestration-metrics__rank-head > strong span { display: block; margin-top: 2px; color: var(--app-muted); font-size: 11px; font-weight: 400; }
.orchestration-metrics__rank-head em { color: var(--app-muted); font-size: 12px; font-style: normal; text-align: right; }
.orchestration-metrics__rank-head em.is-ranked { color: #b45309; font-weight: 600; }
.orchestration-metrics__rank-list b { color: #c96442; font-family: var(--app-mono-font); font-size: 18px; }
.orchestration-metrics__rank-list span { color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__bottleneck-components { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--app-border); border-left: 1px solid var(--app-border); }
.orchestration-metrics__bottleneck-components > div { display: grid; grid-template-columns: minmax(110px, 1fr) auto; gap: 4px 8px; min-width: 0; padding: 10px; border-right: 1px solid var(--app-border); border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__bottleneck-components strong { font-size: 12px; }
.orchestration-metrics__bottleneck-components span { color: var(--app-text); text-align: right; }
.orchestration-metrics__bottleneck-components small { color: var(--app-muted); font-size: 11px; }
.orchestration-metrics__bottleneck-components :deep(.ant-progress),
.orchestration-metrics__bottleneck-components :deep(.ant-tag) { justify-self: end; margin: 0; }
.orchestration-metrics__correlation-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--app-border); border-radius: 8px; }
.orchestration-metrics__correlation-summary div { display: grid; gap: 4px; padding: 14px; }
.orchestration-metrics__correlation-summary span { color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__correlation-summary small { margin-left: 4px; font-size: 11px; font-weight: 400; }
.orchestration-metrics__correlation-summary strong { font-size: 22px; }
.orchestration-metrics__correlation-summary em { color: var(--app-muted); font-size: 12px; font-style: normal; }
.orchestration-metrics__correlation-selectors { display: grid; grid-template-columns: 180px auto 180px; align-items: center; }
.orchestration-metrics__correlation-selectors :deep(.ant-select) { width: 100%; min-width: 0; }
.orchestration-metrics__correlation-selectors > span { color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__correlation-conclusion { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; padding: 12px 14px; border-left: 3px solid var(--app-accent); background: color-mix(in srgb, var(--app-accent) 7%, transparent); }
.orchestration-metrics__correlation-conclusion strong { white-space: nowrap; }
.orchestration-metrics__correlation-conclusion span { color: var(--app-text); font-size: 13px; line-height: 1.65; }
.orchestration-metrics__correlation-method { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--app-border); border-bottom: 1px solid var(--app-border); }
.orchestration-metrics__correlation-method > div { display: grid; gap: 5px; padding: 12px 14px; }
.orchestration-metrics__correlation-method > div + div { border-left: 1px solid var(--app-border); }
.orchestration-metrics__correlation-method strong { font-size: 12px; }
.orchestration-metrics__correlation-method span { color: var(--app-muted); font-size: 12px; line-height: 1.6; }
.orchestration-metrics__scatter-wrap { display: grid; grid-template-columns: 48px minmax(620px, 1fr); grid-template-rows: auto 280px auto auto; min-width: 0; overflow-x: auto; }
.orchestration-metrics__scatter-y-title { grid-column: 1; grid-row: 2; align-self: center; justify-self: center; color: var(--app-muted); font-size: 12px; writing-mode: vertical-rl; transform: rotate(180deg); }
.orchestration-metrics__scatter-y-max { grid-column: 2; grid-row: 1; color: var(--app-muted); font-size: 11px; }
.orchestration-metrics__scatter { position: relative; min-width: 620px; height: 280px; overflow: hidden; border-left: 1px solid var(--app-border); border-bottom: 1px solid var(--app-border); background-image: linear-gradient(to right, color-mix(in srgb, var(--app-border) 45%, transparent) 1px, transparent 1px), linear-gradient(to top, color-mix(in srgb, var(--app-border) 45%, transparent) 1px, transparent 1px); background-size: 20% 25%; }
.orchestration-metrics__scatter i { position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; opacity: .65; transform: translate(-50%, 50%); }
.orchestration-metrics__scatter-wrap .orchestration-metrics__scatter { grid-column: 2; grid-row: 2; }
.orchestration-metrics__scatter-origin { grid-column: 2; grid-row: 3; color: var(--app-muted); font-size: 11px; }
.orchestration-metrics__scatter-x-max { grid-column: 2; grid-row: 3; justify-self: end; color: var(--app-muted); font-size: 11px; }
.orchestration-metrics__scatter-x-title { grid-column: 2; grid-row: 4; justify-self: center; margin-top: 4px; color: var(--app-muted); font-size: 12px; }
.orchestration-metrics__scatter-note { color: var(--app-muted); font-size: 12px; line-height: 1.6; }

@media (max-width: 1180px) {
  .orchestration-metrics__cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .orchestration-metrics__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .orchestration-metrics__metric-card--data-quality strong {
    font-size: 18px;
    white-space: normal;
  }

}

@media (max-width: 720px) {
  .orchestration-metrics__mobile-view-select {
    display: flex;
    width: 100%;
    margin-top: 2px;
  }

  .orchestration-metrics__tabs :deep(.ant-tabs-nav) {
    display: none;
  }

  .orchestration-metrics__experiment-filters,
  .orchestration-metrics__cohort-details { grid-template-columns: minmax(0, 1fr); }
  .orchestration-metrics__evaluation-toolbar { grid-template-columns: minmax(0, 1fr); }
  .orchestration-metrics__toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .orchestration-metrics__toolbar-fields,
  .orchestration-metrics__toolbar-actions {
    flex-wrap: wrap;
  }

  .orchestration-metrics__toolbar-actions {
    justify-content: flex-start;
  }

  .orchestration-metrics__section-head,
  .orchestration-metrics__section-actions,
  .orchestration-metrics__contract-filters {
    align-items: stretch;
    flex-direction: column;
  }

  .orchestration-metrics__contract-filters :deep(.ant-select) {
    width: 100%;
  }

  .orchestration-metrics__analysis-dimension {
    width: 100%;
  }

  .orchestration-metrics__contract-filters > span {
    margin-left: 0;
  }

  .orchestration-metrics__field,
  .orchestration-metrics__field--scope,
  .orchestration-metrics__field--candidate,
  .orchestration-metrics__field--wide {
    width: 100%;
    min-width: 0;
    flex: 1 0 100%;
  }

  .orchestration-metrics__query-button {
    width: 100%;
  }

  .orchestration-metrics__cards,
  .orchestration-metrics__grid,
  .orchestration-metrics__validation {
    grid-template-columns: minmax(0, 1fr);
  }

  .orchestration-metrics__node-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .orchestration-metrics__correlation-summary,
  .orchestration-metrics__correlation-method,
  .orchestration-metrics__flow-summary,
  .orchestration-metrics__flow-legend {
    grid-template-columns: minmax(0, 1fr);
  }

  .orchestration-metrics__path-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .orchestration-metrics__rework-tags {
    justify-content: flex-start;
  }

  .orchestration-metrics__spec-trend-legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .orchestration-metrics__flow-summary > div + div,
  .orchestration-metrics__flow-legend > div:nth-child(even) {
    border-top: 1px solid var(--app-border);
    border-left: 0;
  }

  .orchestration-metrics__flow-legend > div:nth-child(odd),
  .orchestration-metrics__flow-legend > div:nth-child(even) {
    padding-right: 4px;
    padding-left: 4px;
  }

  .orchestration-metrics__correlation-method > div + div {
    border-top: 1px solid var(--app-border);
    border-left: 0;
  }

  .orchestration-metrics__correlation-conclusion {
    grid-template-columns: minmax(0, 1fr);
    gap: 5px;
  }

  .orchestration-metrics__correlation-selectors {
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
  }

  .orchestration-metrics__rank-head,
  .orchestration-metrics__bottleneck-components {
    grid-template-columns: minmax(0, 1fr);
  }

  .orchestration-metrics__rank-head em { text-align: left; }
}
</style>
