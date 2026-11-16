<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { curveMonotoneX, line as d3Line } from "d3";
import { EyeOutlined, InfoCircleOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { ORCHESTRATION_METRIC_DEFINITIONS } from "@codeflowai/shared";
import type {
  OrchestrationMetricCodeAttributionAggregate,
  OrchestrationMetricCodeAttributionCommitItem,
  OrchestrationMetricCodeAttributionDimension,
  OrchestrationMetricCodeAttributionExecutionRef,
  OrchestrationMetricCodeAttributionQualityReason,
  OrchestrationMetricCodeAttributionQualityStatus,
  OrchestrationMetricCodeAttributionReconciliationStatus,
  OrchestrationMetricCodeAttributionResponse,
} from "@codeflowai/shared";

defineOptions({ name: "CodeAttributionView" });

const props = defineProps<{
  data: OrchestrationMetricCodeAttributionResponse | null;
  loading: boolean;
  error: string;
  dimension: OrchestrationMetricCodeAttributionDimension;
  page: number;
  pageSize: number;
  openingEvidenceInstanceId: string | null;
}>();

const emit = defineEmits<{
  dimensionChange: [value: OrchestrationMetricCodeAttributionDimension];
  pageChange: [page: number, pageSize: number];
  openEvidence: [item: OrchestrationMetricCodeAttributionCommitItem, reference: OrchestrationMetricCodeAttributionExecutionRef];
  reload: [];
}>();

type TrendSeriesKey = "aiGeneratedAddedLines" | "retainedAiAddedLines" | "committedAddedLines" | "coveredCommittedAddedLines";
type TrendPoint = {
  index: number;
  x: number;
  bucket: OrchestrationMetricCodeAttributionResponse["trend"][number];
};

const dimensionOptions = [
  { label: "需求", value: "requirement" },
  { label: "实例", value: "instance" },
  { label: "工作流", value: "workflow" },
  { label: "工作区", value: "workspace" },
  { label: "仓库", value: "repository" },
  { label: "语言", value: "language" },
] satisfies Array<{ label: string; value: OrchestrationMetricCodeAttributionDimension }>;

const seriesOptions = [
  { label: "AI 生成行", value: "aiGeneratedAddedLines", color: "#2563eb" },
  { label: "AI 采纳行", value: "retainedAiAddedLines", color: "#059669" },
  { label: "提交新增行", value: "committedAddedLines", color: "#d97706" },
  { label: "完整覆盖行", value: "coveredCommittedAddedLines", color: "#0891b2" },
] satisfies Array<{ label: string; value: TrendSeriesKey; color: string }>;

const visibleSeries = ref<TrendSeriesKey[]>(seriesOptions.map((item) => item.value));
const hoveredTrendIndex = ref<number | null>(null);
const chartElement = ref<HTMLElement | null>(null);
const chartWidth = ref(720);
const dismissedError = ref("");
const dismissedCoverage = ref("");
const dismissedPrivacy = ref(false);
let resizeObserver: ResizeObserver | null = null;

const CHART = { height: 252, left: 48, right: 16, top: 18, bottom: 36 } as const;

const metrics = computed(() => {
  const totals = props.data?.totals ?? null;
  return [
    {
      key: "contribution",
      label: "AI 代码贡献占比",
      value: totals?.aiContributionShare ?? null,
      numerator: totals?.retainedAiAddedLines ?? null,
      denominator: totals?.coveredCommittedAddedLines ?? null,
      secondaryValue: null,
      secondaryNumerator: null,
      secondaryDenominator: null,
      formula: "AI 采纳新增行 / 完整覆盖的提交新增行",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.aiCodeContributionShare,
    },
    {
      key: "adoption",
      label: "AI 产出采纳率",
      value: totals?.aiOutputAdoptionRate ?? null,
      numerator: totals?.retainedAiAddedLines ?? null,
      denominator: totals?.aiGeneratedAddedLines ?? null,
      secondaryValue: null,
      secondaryNumerator: null,
      secondaryDenominator: null,
      formula: "AI 采纳新增行 / AI 生成新增行",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.aiOutputAdoptionRate,
    },
    {
      key: "retention",
      label: "AI 代码留存率",
      value: totals?.retention7Day.retentionRate ?? null,
      numerator: totals?.retention7Day.stillPresentAiAddedLines ?? null,
      denominator: totals?.retention7Day.observedRetainedAiAddedLines ?? null,
      secondaryValue: totals?.retention30Day.retentionRate ?? null,
      secondaryNumerator: totals?.retention30Day.stillPresentAiAddedLines ?? null,
      secondaryDenominator: totals?.retention30Day.observedRetainedAiAddedLines ?? null,
      formula: "7 天、30 天分别计算：观察点仍归属于目标提交的 AI 行 / 已完成观察的提交时 AI 采纳行",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.aiCodeRetentionRate,
    },
    {
      key: "coverage",
      label: "采集覆盖率",
      value: totals?.collectionCoverageRate ?? null,
      numerator: totals?.coveredCommittedAddedLines ?? null,
      denominator: totals?.eligibleCommittedAddedLines ?? null,
      secondaryValue: null,
      secondaryNumerator: null,
      secondaryDenominator: null,
      formula: "完整覆盖的提交新增行 / 符合资格的提交新增行",
      definition: ORCHESTRATION_METRIC_DEFINITIONS.codeAttributionCollectionCoverage,
    },
  ];
});

const coverageSignature = computed(() => props.data
  ? JSON.stringify([props.data.coverageStatus, props.data.coverageReasons, props.data.generatedAt])
  : "");
const showError = computed(() => Boolean(props.error) && dismissedError.value !== props.error);
const showCoverageNotice = computed(() => Boolean(props.data)
  && props.data!.coverageStatus !== "complete"
  && dismissedCoverage.value !== coverageSignature.value);
const showPrivacyNotice = computed(() => props.data?.privacy.status === "suppressed" && !dismissedPrivacy.value);
const coverageMessage = computed(() => props.data?.coverageStatus === "partial"
  ? "代码贡献数据仅覆盖当前范围中的部分提交"
  : "当前范围还没有形成可计算的代码贡献数据");
const coverageDescription = computed(() => {
  const reasons = props.data?.coverageReasons.map(qualityReasonLabel) ?? [];
  return reasons.length ? reasons.join("；") : "相关指标暂不形成结论，缺失证据不会计为人工代码。";
});
const hasFacts = computed(() => (props.data?.totals.factCount ?? 0) > 0 || (props.data?.total ?? 0) > 0);

const plotWidth = computed(() => Math.max(1, chartWidth.value - CHART.left - CHART.right));
const chartMax = computed(() => {
  const selected = new Set(visibleSeries.value);
  const values = (props.data?.trend ?? []).flatMap((bucket) => seriesOptions
    .filter((series) => selected.has(series.value))
    .map((series) => bucket[series.value])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  return Math.max(1, ...values);
});
const trendPoints = computed<TrendPoint[]>(() => (props.data?.trend ?? []).map((bucket, index, rows) => ({
  index,
  bucket,
  x: rows.length === 1
    ? CHART.left + plotWidth.value / 2
    : CHART.left + index * plotWidth.value / Math.max(1, rows.length - 1),
})));
const trendTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
  value: Math.round(chartMax.value * ratio),
  y: CHART.height - CHART.bottom - ratio * (CHART.height - CHART.top - CHART.bottom),
})));
const trendHitWidth = computed(() => plotWidth.value / Math.max(1, trendPoints.value.length - 1));
const hoveredTrendPoint = computed(() => hoveredTrendIndex.value === null
  ? null
  : trendPoints.value[hoveredTrendIndex.value] ?? null);

/** Converts one additive line count into the chart Y coordinate. */
function trendY(value: number): number {
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return CHART.height - CHART.bottom - value / chartMax.value * plotHeight;
}

/** Builds one monotone line without inventing values for privacy-suppressed buckets. */
function trendPath(series: TrendSeriesKey): string {
  return d3Line<TrendPoint>()
    .defined((point) => typeof point.bucket[series] === "number")
    .x((point) => point.x)
    .y((point) => trendY(point.bucket[series] as number))
    .curve(curveMonotoneX)(trendPoints.value) ?? "";
}

/** Reads one plotted value without converting protected data into zero. */
function trendValue(point: TrendPoint, series: TrendSeriesKey): number | null {
  const value = point.bucket[series];
  return typeof value === "number" ? value : null;
}

/** Builds a readable keyboard and screen-reader summary for one trend bucket. */
function trendPointAriaLabel(point: TrendPoint): string {
  const values = seriesOptions
    .filter((series) => visibleSeries.value.includes(series.value))
    .map((series) => `${series.label}${formatCount(trendValue(point, series.value), point.bucket.privacy?.status === "suppressed")}`);
  return `显示${formatDateTime(point.bucket.bucketStart)}趋势详情${values.length ? `，${values.join("，")}` : ""}`;
}

/** Selects one trend point for mouse, touch, and keyboard interactions. */
function activateTrendPoint(index: number): void {
  hoveredTrendIndex.value = index;
}

/** Keeps chart width equal to the actual content region on every viewport. */
function bindResizeObserver(): void {
  resizeObserver?.disconnect();
  const element = chartElement.value;
  if (!element) return;
  const update = (width: number): void => { chartWidth.value = Math.max(280, Math.round(width)); };
  update(element.getBoundingClientRect().width);
  resizeObserver = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? element.getBoundingClientRect().width));
  resizeObserver.observe(element);
}

/** Emits only validated finite code-attribution dimensions. */
function changeDimension(value: string | number): void {
  const match = dimensionOptions.find((option) => option.value === value);
  if (match) emit("dimensionChange", match.value);
}

/** Keeps pagination server-owned and resets the page when page size changes. */
function changePage(page: number, pageSize: number): void {
  emit("pageChange", pageSize === props.pageSize ? page : 1, pageSize);
}

/** Returns a Chinese quality state for visible status tags. */
function qualityStatusLabel(status: OrchestrationMetricCodeAttributionQualityStatus): string {
  return status === "complete" ? "完整" : status === "partial" ? "部分" : "不可用";
}

/** Maps quality state to the existing Ant Design semantic colors. */
function qualityStatusColor(status: OrchestrationMetricCodeAttributionQualityStatus): string {
  return status === "complete" ? "success" : status === "partial" ? "warning" : "default";
}

/** Converts internal quality reasons to customer-readable Chinese. */
function qualityReasonLabel(reason: OrchestrationMetricCodeAttributionQualityReason): string {
  const labels: Record<OrchestrationMetricCodeAttributionQualityReason, string> = {
    ai_trace_missing: "缺少 AI 生成轨迹",
    commit_diff_missing: "缺少提交差异证据",
    association_missing: "缺少编排实例关联",
    hook_not_installed: "尚未安装 AI 轨迹采集 Hook",
    unsupported_tool: "当前 AI 工具尚未接入采集",
    patch_snapshot_missing: "缺少文件变更快照",
    patch_snapshot_corrupt: "文件变更快照校验失败",
    patch_superseded: "文件变更已被后续版本取代",
    history_rewritten: "提交历史已被改写",
    binary_file: "二进制文件不参与统计",
    generated_file: "生成文件不参与统计",
    merge_commit: "合并提交不参与逐行归因",
    ambiguous_attribution: "存在无法唯一判定的代码来源",
    execution_reference_missing: "缺少可下钻的执行证据引用",
    retention_observation_pending: "留存观察期尚未结束",
    retention_observation_missing: "留存观察证据尚未取得",
  };
  return labels[reason];
}

/** Converts reconciliation states to business language without exposing internal codes. */
function reconciliationLabel(status: OrchestrationMetricCodeAttributionReconciliationStatus): string {
  const labels: Record<OrchestrationMetricCodeAttributionReconciliationStatus, string> = {
    ai_trace_received: "等待提交证据",
    commit_received: "等待 AI 轨迹",
    matched: "已对账",
    partial: "部分对账",
    superseded: "已被历史改写",
    excluded: "已排除",
    failed: "对账失败",
  };
  return labels[status];
}

/** Formats a ratio only when the Server supplied an eligible denominator. */
function formatRate(value: number | null, protectedValue = props.data?.privacy.status === "suppressed"): string {
  return value === null ? protectedValue ? "受保护" : "暂不可计算" : `${(value * 100).toFixed(1)}%`;
}

/** Formats protected and available additive counts consistently. */
function formatCount(value: number | null, protectedValue = props.data?.privacy.status === "suppressed"): string {
  return value === null ? protectedValue ? "受保护" : "暂不可用" : value.toLocaleString("zh-CN");
}

/** Formats one observation timestamp in the product locale. */
function formatDateTime(value: number | null): string {
  return value === null ? "尚未观测" : new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** Shortens opaque evidence identities while preserving the full value in title attributes. */
function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

/** Returns the selected dimension's Chinese heading. */
function dimensionHeading(): string {
  return dimensionOptions.find((option) => option.value === props.dimension)?.label ?? "维度";
}

/** Provides a compact Chinese summary for one dimension row. */
function aggregateCoverageLabel(item: OrchestrationMetricCodeAttributionAggregate, protectedValue: boolean): string {
  return formatRate(item.collectionCoverageRate, protectedValue);
}

watch(chartElement, (element) => {
  resizeObserver?.disconnect();
  if (element) void nextTick(bindResizeObserver);
});
watch(() => props.error, () => { dismissedError.value = ""; });
watch(() => props.data?.generatedAt, () => {
  dismissedCoverage.value = "";
  dismissedPrivacy.value = false;
  hoveredTrendIndex.value = null;
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <section class="code-attribution-view" aria-label="AI 代码贡献分析" data-testid="code-attribution-view">
    <a-alert
      v-if="showError"
      type="error"
      show-icon
      closable
      message="代码贡献数据暂时无法加载"
      :description="error"
      @close="dismissedError = error"
    >
      <template #action>
        <a-button type="text" size="small" @click="emit('reload')">
          <template #icon><ReloadOutlined /></template>
          重试
        </a-button>
      </template>
    </a-alert>

    <a-skeleton v-if="loading && !data" active :paragraph="{ rows: 9 }" />
    <template v-else-if="data">
      <a-alert
        v-if="showPrivacyNotice"
        type="info"
        show-icon
        closable
        message="当前范围已启用隐私保护"
        description="样本未达到群体展示条件，指标和代码提交明细已隐藏。"
        @close="dismissedPrivacy = true"
      />
      <a-alert
        v-if="showCoverageNotice"
        :type="data.coverageStatus === 'partial' ? 'warning' : 'info'"
        show-icon
        closable
        :message="`${coverageMessage}。${coverageDescription}`"
        @close="dismissedCoverage = coverageSignature"
      />

      <div class="code-attribution-view__heading">
        <div class="code-attribution-view__heading-title">
          <h3>代码贡献</h3>
          <span>最近观测 {{ formatDateTime(data.totals.latestObservedAt) }}</span>
        </div>
        <a-tag :color="qualityStatusColor(data.coverageStatus)">{{ qualityStatusLabel(data.coverageStatus) }}</a-tag>
      </div>

      <div class="code-attribution-view__metrics">
        <div v-for="metric in metrics" :key="metric.key" class="code-attribution-view__metric">
          <div class="code-attribution-view__metric-label">
            <span>{{ metric.label }}</span>
            <a-popover placement="bottom" trigger="click">
              <template #content>
                <div class="code-attribution-view__definition">
                  <strong>{{ metric.formula }}</strong>
                  <span>分子：{{ metric.definition.numerator }}</span>
                  <span>分母：{{ metric.definition.denominator }}</span>
                  <span>纳入条件：{{ metric.definition.eligibilityRule }}</span>
                  <span>排除与缺失：{{ metric.definition.qualityRule }}</span>
                </div>
              </template>
              <a-button type="text" size="small" :aria-label="`查看${metric.label}说明`">
                <template #icon><InfoCircleOutlined /></template>
              </a-button>
            </a-popover>
          </div>
          <div v-if="metric.key === 'retention'" class="code-attribution-view__retention-values">
            <span><small>7 天</small><strong>{{ formatRate(metric.value) }}</strong></span>
            <span><small>30 天</small><strong>{{ formatRate(metric.secondaryValue) }}</strong></span>
          </div>
          <template v-else>
            <strong>{{ formatRate(metric.value) }}</strong>
          </template>
          <small v-if="metric.key === 'retention'">
            7 天 {{ formatCount(metric.numerator) }}/{{ formatCount(metric.denominator) }} · 30 天 {{ formatCount(metric.secondaryNumerator) }}/{{ formatCount(metric.secondaryDenominator) }}
          </small>
          <small v-else>分子 {{ formatCount(metric.numerator) }} · 分母 {{ formatCount(metric.denominator) }}</small>
        </div>
      </div>

      <div class="code-attribution-view__delivery-signals">
        <span>交付关联 <strong>{{ formatCount(data.totals.deliveryQuality.linkedCommitCount) }}</strong></span>
        <span>返工 <strong>{{ formatCount(data.totals.deliveryQuality.reworkCommitCount) }}</strong></span>
        <span>回滚 <strong>{{ formatCount(data.totals.deliveryQuality.rollbackCommitCount) }}</strong></span>
        <span>恢复 <strong>{{ formatCount(data.totals.deliveryQuality.recoveryCommitCount) }}</strong></span>
        <a-popover placement="bottom" trigger="click">
          <template #content>
            <div class="code-attribution-view__definition">
              <strong>交付质量关联口径</strong>
              <span>仅关联同一用户、工作区、编排实例、仓库和提交的已对账交付事实。</span>
              <span>返工、回滚和恢复是描述性计数，不表示 AI 代码或某个模型导致了该结果。</span>
            </div>
          </template>
          <a-button type="text" size="small" aria-label="查看交付质量关联说明"><template #icon><InfoCircleOutlined /></template></a-button>
        </a-popover>
      </div>

      <a-empty v-if="!hasFacts" description="当前筛选范围暂无代码贡献数据" />
      <template v-else>
        <section class="code-attribution-view__section">
          <div class="code-attribution-view__section-head">
            <div class="code-attribution-view__section-title">
              <h4>执行趋势</h4>
              <span>{{ data.trend.length }} 个时间段</span>
            </div>
            <a-checkbox-group v-model:value="visibleSeries" :options="seriesOptions" />
          </div>
          <div v-if="trendPoints.length" class="code-attribution-view__chart" @mouseleave="hoveredTrendIndex = null">
            <div ref="chartElement" class="code-attribution-view__chart-canvas">
              <svg :viewBox="`0 0 ${chartWidth} ${CHART.height}`" role="img" aria-label="代码贡献执行趋势曲线图">
                <g v-for="tick in trendTicks" :key="tick.y">
                  <line class="code-attribution-view__grid-line" :x1="CHART.left" :x2="chartWidth - CHART.right" :y1="tick.y" :y2="tick.y" />
                  <text class="code-attribution-view__axis-label" :x="CHART.left - 8" :y="tick.y + 4" text-anchor="end">{{ tick.value }}</text>
                </g>
                <path
                  v-for="series in seriesOptions.filter((item) => visibleSeries.includes(item.value))"
                  :key="series.value"
                  class="code-attribution-view__line"
                  :d="trendPath(series.value)"
                  :style="{ stroke: series.color }"
                />
                <g v-for="point in trendPoints" :key="point.bucket.bucketStart">
                  <template v-for="series in seriesOptions.filter((item) => visibleSeries.includes(item.value))" :key="series.value">
                    <circle
                      v-if="trendValue(point, series.value) !== null"
                      class="code-attribution-view__point"
                      :class="{ 'is-active': hoveredTrendIndex === point.index }"
                      :cx="point.x"
                      :cy="trendY(trendValue(point, series.value)!)"
                      :style="{ fill: series.color }"
                      r="3.5"
                    />
                  </template>
                  <text
                    v-if="point.index === 0 || point.index === trendPoints.length - 1 || point.index % Math.max(1, Math.ceil(trendPoints.length / 6)) === 0"
                    class="code-attribution-view__axis-label"
                    :x="point.x"
                    :y="CHART.height - 10"
                    text-anchor="middle"
                  >{{ new Date(point.bucket.bucketStart).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) }}</text>
                   <rect
                     class="code-attribution-view__hit"
                    :x="point.x - trendHitWidth / 2"
                    :y="CHART.top"
                    :width="trendHitWidth"
                    :height="CHART.height - CHART.top - CHART.bottom"
                     tabindex="0"
                     role="button"
                     :aria-label="trendPointAriaLabel(point)"
                     @mouseenter="activateTrendPoint(point.index)"
                     @focus="activateTrendPoint(point.index)"
                     @blur="hoveredTrendIndex = null"
                     @click="activateTrendPoint(point.index)"
                     @keydown.enter.prevent="activateTrendPoint(point.index)"
                     @keydown.space.prevent="activateTrendPoint(point.index)"
                   />
                </g>
                <line
                  v-if="hoveredTrendPoint"
                  class="code-attribution-view__crosshair"
                  :x1="hoveredTrendPoint.x"
                  :x2="hoveredTrendPoint.x"
                  :y1="CHART.top"
                  :y2="CHART.height - CHART.bottom"
                />
              </svg>
              <div
                v-if="hoveredTrendPoint"
                class="code-attribution-view__tooltip"
                :style="{ left: `${Math.min(90, Math.max(10, hoveredTrendPoint.x / chartWidth * 100))}%` }"
              >
                <strong>{{ formatDateTime(hoveredTrendPoint.bucket.bucketStart) }}</strong>
                <span v-for="series in seriesOptions.filter((item) => visibleSeries.includes(item.value))" :key="series.value">
                  <i :style="{ background: series.color }" />{{ series.label }} {{ formatCount(trendValue(hoveredTrendPoint, series.value), hoveredTrendPoint.bucket.privacy?.status === 'suppressed') }}
                </span>
              </div>
            </div>
          </div>
          <a-empty v-else description="当前范围暂无趋势数据" />
        </section>

        <section class="code-attribution-view__section">
          <div class="code-attribution-view__section-head">
            <div class="code-attribution-view__section-title">
              <h4>{{ dimensionHeading() }}分析</h4>
              <span>{{ data.groups.length }} 个分组</span>
            </div>
            <div class="code-attribution-view__dimension-segmented">
              <a-segmented :value="dimension" :options="dimensionOptions" data-testid="code-attribution-dimension" @change="changeDimension" />
            </div>
            <div class="code-attribution-view__dimension-select">
              <a-select :value="dimension" :options="dimensionOptions" aria-label="选择代码贡献分析维度" @change="changeDimension" />
            </div>
          </div>
          <a-table
            size="small"
            row-key="dimensionKey"
            :data-source="data.groups"
            :pagination="false"
            :scroll="{ x: 900, y: 300 }"
            :locale="{ emptyText: '当前维度暂无数据' }"
          >
            <a-table-column :title="dimensionHeading()" data-index="dimensionLabel" :width="220" fixed="left" :ellipsis="true" />
            <a-table-column title="AI 生成行" :width="110" align="right"><template #default="{ record }">{{ formatCount(record.aiGeneratedAddedLines, record.privacy?.status === 'suppressed') }}</template></a-table-column>
            <a-table-column title="AI 采纳行" :width="110" align="right"><template #default="{ record }">{{ formatCount(record.retainedAiAddedLines, record.privacy?.status === 'suppressed') }}</template></a-table-column>
            <a-table-column title="提交新增行" :width="120" align="right"><template #default="{ record }">{{ formatCount(record.committedAddedLines, record.privacy?.status === 'suppressed') }}</template></a-table-column>
            <a-table-column title="贡献占比" :width="110" align="right"><template #default="{ record }">{{ formatRate(record.aiContributionShare, record.privacy?.status === 'suppressed') }}</template></a-table-column>
            <a-table-column title="采纳率" :width="100" align="right"><template #default="{ record }">{{ formatRate(record.aiOutputAdoptionRate, record.privacy?.status === 'suppressed') }}</template></a-table-column>
            <a-table-column title="覆盖率" :width="100" align="right"><template #default="{ record }">{{ aggregateCoverageLabel(record, record.privacy?.status === 'suppressed') }}</template></a-table-column>
          </a-table>
        </section>

        <section class="code-attribution-view__section">
          <div class="code-attribution-view__section-head">
            <div class="code-attribution-view__section-title">
              <h4>代码提交明细</h4>
              <span>共 {{ data.total }} 个代码提交</span>
            </div>
          </div>
          <a-table
            size="small"
            row-key="sourceBatchId"
            :data-source="data.items"
            :pagination="false"
            :scroll="{ x: 1120, y: 360 }"
            :locale="{ emptyText: '当前页暂无提交明细' }"
          >
            <template #expandedRowRender="{ record }">
              <div class="code-attribution-view__execution-list">
                <div v-for="reference in record.executionRefs" :key="`${reference.attemptId}:${reference.attemptNo}:${reference.promptSnapshotId}`">
                  <span>{{ reference.nodeId }} · 第 {{ reference.attemptNo }} 轮</span>
                  <code :title="reference.promptSnapshotId">提示词快照 {{ shortId(reference.promptSnapshotId) }}</code>
                  <code :title="`${reference.threadId}/${reference.turnId}`">会话 {{ shortId(reference.threadId) }} / {{ shortId(reference.turnId) }}</code>
                  <a-button
                    type="text"
                    size="small"
                    :loading="openingEvidenceInstanceId === record.instanceId"
                    :aria-label="`查看${reference.nodeId}第${reference.attemptNo}轮运行证据`"
                    @click="emit('openEvidence', record, reference)"
                  >
                    <template #icon><EyeOutlined /></template>
                  </a-button>
                </div>
                <a-empty v-if="!record.executionRefs.length" description="该提交暂无可下钻执行证据" />
              </div>
            </template>
            <a-table-column title="提交编号" :width="140" fixed="left"><template #default="{ record }"><code :title="record.commitSha">{{ shortId(record.commitSha) }}</code></template></a-table-column>
            <a-table-column title="仓库" data-index="repository" :width="200" :ellipsis="true" />
            <a-table-column title="需求 / 工作流" :width="240"><template #default="{ record }"><span>{{ record.titleSummary || '未关联需求' }}</span><small>{{ record.workflowName }}</small></template></a-table-column>
            <a-table-column title="质量" :width="92">
              <template #default="{ record }">
                <a-tooltip
                  :title="record.qualityReasons.length ? record.qualityReasons.map(qualityReasonLabel).join('；') : qualityStatusLabel(record.qualityStatus)"
                  :trigger="['hover', 'focus']"
                >
                  <a-tag
                    :color="qualityStatusColor(record.qualityStatus)"
                    tabindex="0"
                    :aria-label="`质量${qualityStatusLabel(record.qualityStatus)}${record.qualityReasons.length ? `：${record.qualityReasons.map(qualityReasonLabel).join('；')}` : ''}`"
                  >{{ qualityStatusLabel(record.qualityStatus) }}</a-tag>
                </a-tooltip>
              </template>
            </a-table-column>
            <a-table-column title="对账" :width="110"><template #default="{ record }">{{ reconciliationLabel(record.reconciliationStatus) }}</template></a-table-column>
            <a-table-column title="AI 采纳行" :width="110" align="right"><template #default="{ record }">{{ formatCount(record.retainedAiAddedLines) }}</template></a-table-column>
            <a-table-column title="提交新增行" :width="120" align="right"><template #default="{ record }">{{ formatCount(record.committedAddedLines) }}</template></a-table-column>
            <a-table-column title="贡献占比" :width="110" align="right"><template #default="{ record }">{{ formatRate(record.aiContributionShare) }}</template></a-table-column>
            <a-table-column title="交付信号" :width="150">
              <template #default="{ record }">
                <span v-if="(record.deliveryQuality.reworkCommitCount ?? 0) + (record.deliveryQuality.rollbackCommitCount ?? 0) + (record.deliveryQuality.recoveryCommitCount ?? 0) === 0">-</span>
                <a-tag v-if="record.deliveryQuality.reworkCommitCount">返工</a-tag>
                <a-tag v-if="record.deliveryQuality.rollbackCommitCount" color="red">回滚</a-tag>
                <a-tag v-if="record.deliveryQuality.recoveryCommitCount" color="green">恢复</a-tag>
              </template>
            </a-table-column>
            <a-table-column title="观测时间" :width="170"><template #default="{ record }">{{ formatDateTime(record.observedAt) }}</template></a-table-column>
          </a-table>
          <div v-if="data.total > 0" class="code-attribution-view__pagination">
            <a-pagination
              :current="page"
              :page-size="pageSize"
              :total="data.total"
              size="small"
              show-size-changer
              :page-size-options="['10', '20', '50', '100']"
              :locale="{ items_per_page: '条/页' }"
              @change="changePage"
            />
          </div>
        </section>
       </template>
     </template>
    <div v-else-if="error && showError" class="code-attribution-view__error-space" />
    <a-empty v-else-if="error" description="代码贡献数据暂不可用">
      <a-button @click="emit('reload')">
        <template #icon><ReloadOutlined /></template>
        重新加载
      </a-button>
    </a-empty>
    <a-empty v-else description="当前筛选范围暂无代码贡献数据" />
   </section>
 </template>

<style scoped>
.code-attribution-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 620px;
  padding: 10px 0 18px;
}

.code-attribution-view__heading,
.code-attribution-view__section-head,
.code-attribution-view__metric-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.code-attribution-view__heading-title,
.code-attribution-view__section-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.code-attribution-view h3,
.code-attribution-view h4 {
  margin: 0;
  color: var(--app-text);
  letter-spacing: 0;
}

.code-attribution-view h3 { font-size: 16px; }
.code-attribution-view h4 { font-size: 14px; }
.code-attribution-view__heading span,
.code-attribution-view__section-head span,
.code-attribution-view__metric small,
.code-attribution-view__execution-list small { color: var(--app-muted); font-size: 12px; }

.code-attribution-view__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: 1px solid var(--app-border);
  border-bottom: 1px solid var(--app-border);
}

.code-attribution-view__metric {
  min-width: 0;
  padding: 10px 14px;
  border-right: 1px solid var(--app-border);
}

.code-attribution-view__metric:last-child { border-right: 0; }
.code-attribution-view__metric-label { justify-content: flex-start; gap: 3px; color: var(--app-muted); font-size: 12px; }
.code-attribution-view__metric-label .ant-btn { width: 26px; height: 26px; padding: 0; }
.code-attribution-view__metric > strong { display: block; margin: 2px 0; font-size: 22px; line-height: 1.25; }
.code-attribution-view__metric > small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-attribution-view__retention-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.code-attribution-view__retention-values span { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.code-attribution-view__retention-values strong { font-size: 18px; line-height: 1.25; }
.code-attribution-view__delivery-signals { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; min-height: 28px; color: var(--app-muted); font-size: 12px; }
.code-attribution-view__delivery-signals strong { color: var(--app-text); font-size: 13px; }
.code-attribution-view__delivery-signals .ant-btn { width: 26px; height: 26px; padding: 0; }

.code-attribution-view__definition {
  display: grid;
  gap: 6px;
  max-width: 420px;
  color: var(--app-text);
  font-size: 12px;
}

.code-attribution-view__definition span { line-height: 1.5; }
.code-attribution-view__section { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; gap: 8px; min-width: 0; overflow: hidden; padding-top: 4px; }
.code-attribution-view__section + .code-attribution-view__section { border-top: 1px solid var(--app-border); padding-top: 12px; }
.code-attribution-view__section-head { width: 100%; min-width: 0; min-height: 32px; }
.code-attribution-view__chart { width: 100%; min-width: 0; overflow: hidden; }
.code-attribution-view__chart-canvas { position: relative; width: 100%; height: 252px; }
.code-attribution-view__chart svg { display: block; width: 100%; height: 252px; overflow: visible; }
.code-attribution-view__grid-line { stroke: var(--app-border); stroke-width: 1; }
.code-attribution-view__axis-label { fill: var(--app-muted); font-size: 11px; }
.code-attribution-view__line { fill: none; stroke-width: 2.25; vector-effect: non-scaling-stroke; }
.code-attribution-view__point { stroke: var(--app-surface); stroke-width: 2; vector-effect: non-scaling-stroke; }
.code-attribution-view__point.is-active { r: 5; }
.code-attribution-view__hit { fill: transparent; cursor: crosshair; }
.code-attribution-view__crosshair { stroke: var(--app-muted); stroke-dasharray: 4 4; stroke-width: 1; }
.code-attribution-view__tooltip {
  position: absolute;
  top: 14px;
  display: grid;
  gap: 4px;
  min-width: 180px;
  padding: 8px 10px;
  transform: translateX(-50%);
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  box-shadow: 0 8px 24px rgb(15 23 42 / 12%);
  pointer-events: none;
  font-size: 12px;
  z-index: 2;
}

.code-attribution-view__tooltip span { display: flex; align-items: center; gap: 6px; }
.code-attribution-view__tooltip i { width: 8px; height: 8px; border-radius: 50%; }
.code-attribution-view__dimension-select { display: none; width: 150px; }
.code-attribution-view__dimension-select :deep(.ant-select) { width: 100%; }
.code-attribution-view__execution-list { display: grid; gap: 6px; padding: 4px 20px 8px 42px; }
.code-attribution-view__execution-list > div { display: grid; grid-template-columns: minmax(140px, 0.8fr) minmax(170px, 1fr) minmax(240px, 1.4fr) 32px; align-items: center; gap: 10px; min-height: 32px; }
.code-attribution-view__execution-list code { overflow: hidden; color: var(--app-muted); text-overflow: ellipsis; white-space: nowrap; }
.code-attribution-view__pagination { display: flex; justify-content: flex-end; min-height: 32px; }
.code-attribution-view__error-space { min-height: 200px; }
.code-attribution-view :deep(.ant-table-cell small) { display: block; color: var(--app-muted); font-size: 12px; }

@media (max-width: 900px) {
  .code-attribution-view__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .code-attribution-view__metric:nth-child(2) { border-right: 0; }
  .code-attribution-view__metric:nth-child(-n + 2) { border-bottom: 1px solid var(--app-border); }
}

@media (max-width: 720px) {
  .code-attribution-view { min-height: 560px; padding-top: 8px; }
  .code-attribution-view__heading,
  .code-attribution-view__section-head { align-items: flex-start; }
  .code-attribution-view__section-title { display: grid; gap: 1px; }
  .code-attribution-view__metric { padding: 9px 10px; }
  .code-attribution-view__metric > strong { font-size: 19px; }
  .code-attribution-view__dimension-segmented { display: none; }
  .code-attribution-view__dimension-select { display: block; }
  .code-attribution-view__section-head :deep(.ant-checkbox-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; }
  .code-attribution-view__execution-list { padding-left: 8px; }
  .code-attribution-view__execution-list > div { grid-template-columns: minmax(120px, 1fr) 32px; }
  .code-attribution-view__execution-list code { grid-column: 1 / -1; }
  .code-attribution-view__tooltip { min-width: 160px; }
}
</style>
