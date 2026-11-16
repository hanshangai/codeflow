<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { curveMonotoneX, line as d3Line, scaleLinear } from "d3";

defineOptions({ name: "OrchestrationMetricLineChart" });

export type OrchestrationMetricLineChartSeries = {
  key: string;
  label: string;
  color: string;
  unit: "count" | "rate";
};

export type OrchestrationMetricLineChartPoint = {
  key: string | number;
  label: string;
  values: Record<string, number | null>;
  protected?: boolean;
};

const props = withDefaults(defineProps<{
  title: string;
  meta?: string;
  ariaLabel?: string;
  series: readonly OrchestrationMetricLineChartSeries[];
  points: readonly OrchestrationMetricLineChartPoint[];
  loading?: boolean;
  errorMessage?: string;
  emptyDescription?: string;
}>(), {
  meta: "",
  ariaLabel: "趋势曲线图",
  loading: false,
  errorMessage: "",
  emptyDescription: "当前范围暂无趋势数据",
});

const CHART = { minWidth: 640, height: 252, left: 52, right: 18, top: 18, bottom: 38 } as const;
const chartElement = ref<HTMLElement | null>(null);
const chartWidth = ref<number>(CHART.minWidth);
const hoveredPointIndex = ref<number | null>(null);
const visibleSeries = ref<string[]>(props.series.map((item) => item.key));
const dismissedErrorMessage = ref("");
let resizeObserver: ResizeObserver | null = null;

const seriesOptions = computed(() => props.series.map(({ key, label }) => ({ key, label, value: key })));
const selectedSeries = computed(() => props.series.filter((item) => visibleSeries.value.includes(item.key)));
const plotWidth = computed(() => Math.max(1, chartWidth.value - CHART.left - CHART.right));
const plotHeight = CHART.height - CHART.top - CHART.bottom;
const chartMax = computed(() => {
  const values = props.points.flatMap((point) => selectedSeries.value
    .map((series) => point.values[series.key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  if (selectedSeries.value.length > 0 && selectedSeries.value.every((series) => series.unit === "rate")) return 1;
  return Math.max(1, ...values);
});
const axisUnit = computed(() => selectedSeries.value[0]?.unit ?? props.series[0]?.unit ?? "count");
const chartPoints = computed(() => props.points.map((point, index, points) => ({
  point,
  index,
  x: points.length <= 1 ? CHART.left + plotWidth.value / 2 : CHART.left + index * plotWidth.value / (points.length - 1),
})));
const chartTicks = computed(() => [...new Set([0, ...scaleLinear().domain([0, chartMax.value]).ticks(4), chartMax.value])]
  .sort((left, right) => left - right)
  .map((value) => ({
    value,
    y: CHART.top + (1 - value / chartMax.value) * plotHeight,
  })));
const hitWidth = computed(() => plotWidth.value / Math.max(1, chartPoints.value.length - 1));
const hoveredPoint = computed(() => hoveredPointIndex.value === null ? null : chartPoints.value[hoveredPointIndex.value] ?? null);
const visibleErrorMessage = computed(() => {
  const message = props.errorMessage.trim();
  return message && message !== dismissedErrorMessage.value ? message : "";
});

/** Formats chart values consistently for axes, tooltips, and screen readers. */
function formatValue(value: number | null | undefined, series: OrchestrationMetricLineChartSeries, protectedValue = false): string {
  if (value == null || !Number.isFinite(value)) return protectedValue ? "受保护" : "暂无数据";
  if (series.unit === "rate") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("zh-CN");
}

/** Converts a visible value to the SVG Y coordinate without inventing missing values. */
function valueY(value: number): number {
  return CHART.top + (1 - value / chartMax.value) * plotHeight;
}

/** Builds one smooth path and leaves gaps where the Server withheld a value. */
function seriesPath(series: OrchestrationMetricLineChartSeries): string {
  return d3Line<typeof chartPoints.value[number]>()
    .defined((item) => typeof item.point.values[series.key] === "number" && Number.isFinite(item.point.values[series.key]))
    .x((item) => item.x)
    .y((item) => valueY(item.point.values[series.key] as number))
    .curve(curveMonotoneX)(chartPoints.value) ?? "";
}

/** Produces a localized Y-axis label for the selected metric unit. */
function formatAxisValue(value: number): string {
  return axisUnit.value === "rate" ? `${Math.round(value * 100)}%` : value.toLocaleString("zh-CN");
}

/** Selects a bucket for mouse, touch, and keyboard inspection. */
function activatePoint(index: number): void {
  hoveredPointIndex.value = index;
}

/** Hides one recoverable chart error until the parent reports a new message. */
function dismissError(): void {
  dismissedErrorMessage.value = props.errorMessage.trim();
}

/** Keeps one series visible so the chart never becomes an interaction dead end. */
function ensureVisibleSeries(): void {
  if (visibleSeries.value.length > 0 || props.series.length === 0) return;
  visibleSeries.value = [props.series[0]!.key];
}

/** Builds a complete bucket description for keyboard and assistive-technology users. */
function pointAriaLabel(item: typeof chartPoints.value[number]): string {
  const values = selectedSeries.value.map((series) => `${series.label}${formatValue(item.point.values[series.key], series, item.point.protected)}`);
  return `${item.point.label}：${values.join("，")}`;
}

/** Observes the actual plot width and rebinds after conditional rendering. */
function bindResizeObserver(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  const element = chartElement.value;
  if (!element) return;
  const update = (width: number): void => { chartWidth.value = Math.max(CHART.minWidth, Math.round(width)); };
  update(element.getBoundingClientRect().width);
  resizeObserver = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? element.getBoundingClientRect().width));
  resizeObserver.observe(element);
}

watch(() => props.series, (series) => {
  const allowed = new Set(series.map((item) => item.key));
  visibleSeries.value = visibleSeries.value.filter((key) => allowed.has(key));
  if (visibleSeries.value.length === 0) visibleSeries.value = series.map((item) => item.key);
}, { deep: true });
watch(visibleSeries, ensureVisibleSeries);
watch(chartElement, (element) => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (element) void nextTick(bindResizeObserver);
});
watch(() => props.points, () => { hoveredPointIndex.value = null; }, { deep: true });
watch(() => props.errorMessage, (message) => {
  if (!message || message.trim() !== dismissedErrorMessage.value) dismissedErrorMessage.value = "";
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <section class="orchestration-metric-line-chart" :aria-label="title">
    <div class="orchestration-metric-line-chart__head">
      <div>
        <h3>{{ title }}</h3>
        <span v-if="meta">{{ meta }}</span>
      </div>
      <a-checkbox-group
        v-model:value="visibleSeries"
        :options="seriesOptions"
        class="orchestration-metric-line-chart__legend"
      />
    </div>
    <div class="orchestration-metric-line-chart__plot">
      <a-alert
        v-if="visibleErrorMessage"
        type="warning"
        show-icon
        closable
        :message="visibleErrorMessage"
        class="orchestration-metric-line-chart__error"
        @close="dismissError"
      />
      <div v-if="loading && !chartPoints.length" class="orchestration-metric-line-chart__empty" role="status" aria-live="polite">
        <a-spin />
        <span>趋势数据加载中...</span>
      </div>
      <div v-else-if="chartPoints.length" ref="chartElement" class="orchestration-metric-line-chart__canvas" @mouseleave="hoveredPointIndex = null">
        <svg :viewBox="`0 0 ${chartWidth} ${CHART.height}`" role="img" :aria-label="ariaLabel">
          <g v-for="tick in chartTicks" :key="tick.value">
            <line class="orchestration-metric-line-chart__grid" :x1="CHART.left" :x2="chartWidth - CHART.right" :y1="tick.y" :y2="tick.y" />
            <text class="orchestration-metric-line-chart__axis" :x="CHART.left - 9" :y="tick.y + 4" text-anchor="end">{{ formatAxisValue(tick.value) }}</text>
          </g>
          <line class="orchestration-metric-line-chart__axis-line" :x1="CHART.left" :x2="chartWidth - CHART.right" :y1="CHART.height - CHART.bottom" :y2="CHART.height - CHART.bottom" />
          <path
            v-for="series in selectedSeries"
            :key="series.key"
            class="orchestration-metric-line-chart__line"
            :d="seriesPath(series)"
            :style="{ stroke: series.color }"
          />
          <g v-for="item in chartPoints" :key="item.point.key">
            <text
              v-if="item.index === 0 || item.index === chartPoints.length - 1 || item.index % Math.max(1, Math.ceil(chartPoints.length / 6)) === 0"
              class="orchestration-metric-line-chart__axis"
              :x="item.x"
              :y="CHART.height - 11"
              text-anchor="middle"
            >{{ item.point.label }}</text>
            <template v-for="series in selectedSeries" :key="series.key">
              <circle
                v-if="typeof item.point.values[series.key] === 'number'"
                class="orchestration-metric-line-chart__point"
                :class="{ 'is-active': hoveredPointIndex === item.index }"
                :cx="item.x"
                :cy="valueY(item.point.values[series.key] as number)"
                :style="{ fill: series.color }"
                r="3.5"
              />
            </template>
            <rect
              class="orchestration-metric-line-chart__hit"
              :x="item.x - hitWidth / 2"
              :y="CHART.top"
              :width="hitWidth"
              :height="CHART.height - CHART.top - CHART.bottom"
              tabindex="0"
              role="button"
              :aria-label="pointAriaLabel(item)"
              @mouseenter="activatePoint(item.index)"
              @focus="activatePoint(item.index)"
              @blur="hoveredPointIndex = null"
              @click="activatePoint(item.index)"
              @keydown.enter.prevent="activatePoint(item.index)"
              @keydown.space.prevent="activatePoint(item.index)"
            />
          </g>
          <line
            v-if="hoveredPoint"
            class="orchestration-metric-line-chart__crosshair"
            :x1="hoveredPoint.x"
            :x2="hoveredPoint.x"
            :y1="CHART.top"
            :y2="CHART.height - CHART.bottom"
          />
        </svg>
        <div
          v-if="hoveredPoint"
          class="orchestration-metric-line-chart__tooltip"
          :style="{ left: `${Math.min(91, Math.max(9, hoveredPoint.x / chartWidth * 100))}%` }"
        >
          <strong>{{ hoveredPoint.point.label }}</strong>
          <span v-for="series in selectedSeries" :key="series.key">
            <i :style="{ background: series.color }" />{{ series.label }} {{ formatValue(hoveredPoint.point.values[series.key], series, hoveredPoint.point.protected) }}
          </span>
        </div>
      </div>
      <a-empty v-else-if="!visibleErrorMessage" :description="emptyDescription" />
    </div>
  </section>
</template>

<style scoped>
.orchestration-metric-line-chart { display: grid; gap: 12px; min-width: 0; padding: 16px 18px 14px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-panel-bg, #fff); }
.orchestration-metric-line-chart__error { margin-bottom: 2px; }
.orchestration-metric-line-chart__head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; min-width: 0; }
.orchestration-metric-line-chart__head > div { min-width: 0; }
.orchestration-metric-line-chart__head h3 { margin: 0; font-size: 16px; line-height: 1.3; }
.orchestration-metric-line-chart__head span { display: block; margin-top: 4px; color: var(--app-muted); font-size: 12px; }
.orchestration-metric-line-chart__legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 12px; }
.orchestration-metric-line-chart__plot { min-width: 0; min-height: 252px; overflow-x: auto; }
.orchestration-metric-line-chart__canvas { position: relative; min-width: 640px; width: 100%; height: 252px; }
.orchestration-metric-line-chart__canvas svg { display: block; width: 100%; height: 252px; overflow: visible; }
.orchestration-metric-line-chart__grid { stroke: var(--app-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.orchestration-metric-line-chart__axis-line { stroke: var(--app-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.orchestration-metric-line-chart__axis { fill: var(--app-muted); font-size: 11px; }
.orchestration-metric-line-chart__line { fill: none; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.orchestration-metric-line-chart__point { stroke: var(--app-panel-bg, #fff); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.orchestration-metric-line-chart__point.is-active { r: 5.5; stroke-width: 2; }
.orchestration-metric-line-chart__hit { fill: transparent; cursor: crosshair; outline: none; }
.orchestration-metric-line-chart__hit:focus-visible { fill: color-mix(in srgb, var(--app-primary, #1677ff) 9%, transparent); stroke: var(--app-primary, #1677ff); stroke-dasharray: 3 3; }
.orchestration-metric-line-chart__crosshair { stroke: var(--app-primary, #1677ff); stroke-dasharray: 4 4; stroke-width: 1; pointer-events: none; vector-effect: non-scaling-stroke; }
.orchestration-metric-line-chart__tooltip { position: absolute; top: 8px; z-index: 2; display: grid; min-width: 160px; max-width: 260px; gap: 4px; padding: 9px 11px; transform: translateX(-50%); border: 1px solid var(--app-border); border-radius: 5px; background: var(--app-panel-bg, #fff); box-shadow: 0 4px 14px rgb(15 23 42 / 12%); font-size: 12px; pointer-events: none; }
.orchestration-metric-line-chart__tooltip strong { font-size: 12px; }
.orchestration-metric-line-chart__tooltip span { display: flex; gap: 6px; align-items: center; color: var(--app-muted); }
.orchestration-metric-line-chart__tooltip i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; }
.orchestration-metric-line-chart__empty { display: grid; place-items: center; align-content: center; height: 252px; gap: 8px; color: var(--app-muted); font-size: 12px; }
@media (max-width: 720px) {
  .orchestration-metric-line-chart__head { flex-direction: column; }
  .orchestration-metric-line-chart__legend { justify-content: flex-start; }
}
</style>
